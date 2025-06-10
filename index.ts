import { pluginGracefulServer } from "graceful-server-elysia";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import { Elysia, t } from "elysia";
import NodeCache from "node-cache";
import {
  createPinoLogger,
  logger as loggerMiddleware,
} from "@bogeychan/elysia-logger";

import type { SunatCredentials } from "./types";
import { scraper } from "./scraper";

const DEFAULT_TIMEOUT_MS = 30000 * 5;

const getGenericQuerySchema = (params?: {
  withTaxPeriod?: boolean;
  withTicketId?: boolean;
}) =>
  t.Object({
    sol_username: t.String({ minLength: 3, maxLength: 8 }),
    sol_key: t.String({ minLength: 2, maxLength: 12 }),
    ruc: t.String({ minLength: 11, maxLength: 11 }),
    ...(params?.withTaxPeriod && {
      tax_period: t.String({ minLength: 6, maxLength: 6 }),
    }),
    ...(params?.withTicketId && {
      ticket_id: t.String({ minLength: 10, maxLength: 45 }),
    }),
  });

const logger = createPinoLogger({
  level: "trace",
  base: undefined,
});

const main = async () => {
  let browser: Browser | undefined;

  const cache = new NodeCache({ stdTTL: 60 * 59 });

  const appApiKey = process.env.APP_API_KEY;
  if (!appApiKey) {
    throw new Error("please set the API key");
  }

  let lastContextsCount = 0;
  let unchangedCount = 0;

  setInterval(async () => {
    if (browser) {
      const contextsCount = browser.contexts().length;

      logger.trace(`[ripper] ${contextsCount} contexts are open...`);

      if (contextsCount === 0) {
        logger.trace("[ripper] closing browser...");
        await browser.close({ reason: "is unused for now" });
        browser = undefined;
        logger.trace("[ripper] browser was closed");
        return;
      }

      if (contextsCount === lastContextsCount) {
        unchangedCount++;
      } else {
        unchangedCount = 0;
      }

      lastContextsCount = contextsCount;

      if (unchangedCount >= 2) {
        // 2 checks = 1 minute
        logger.trace(
          "[ripper] contexts unchanged for too long, force closing browser...",
        );
        await browser.close({ reason: "stale contexts" });
        browser = undefined;
        logger.trace("[ripper] browser was force closed");
      }
    }
  }, 1000 * 30);

  const getSunatToken = async (
    credentials: SunatCredentials,
    legacy: boolean,
  ): Promise<string | null> => {
    const cacheKey = credentials.ruc + legacy;

    const cachedToken = cache.get<string>(cacheKey);
    if (cachedToken) {
      return cachedToken;
    }

    if (!browser) {
      logger.trace("launching new browser...");
      browser = await chromium.launch({
        headless: false,
        executablePath: process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH,
        timeout: DEFAULT_TIMEOUT_MS,
        args: ["--disable-gpu"],
      });
    } else {
      logger.trace(`[init] ${browser.contexts().length} contexts are open...`);
    }

    const token = await (legacy
      ? scraper.getSunatToken(logger, browser, credentials)
      : scraper.getSunatTokenV2(logger, browser, credentials));
    if (!token) {
      logger.warn("sunat token could not be retrieved");
      return null;
    }

    logger.debug("sunat token was retrieved, saving it to cache...", { token });

    const ok = cache.set(cacheKey, token);
    if (!ok) {
      logger.warn({ ruc: credentials.ruc }, "token could not be set to cache");
    }

    logger.trace(`[end] ${browser.contexts().length} contexts are open...`);

    return token;
  };

  const app = new Elysia()
    .use(
      loggerMiddleware({ level: "debug", autoLogging: true, base: undefined }),
    )
    .guard({
      beforeHandle: async ({ headers, path, error }) => {
        logger.debug({ path }, "new request was received");

        const apiKey = headers["x-api-key"];
        if (!apiKey) {
          logger.warn('missing "X-API-Key" header');
          return error(401, "Unauthorized");
        }

        if (!apiKey || apiKey !== appApiKey) {
          logger.warn('invalid "X-API-Key" header');
          return error(401, "Unauthorized");
        }
      },
    })
    .get(
      "/sunat-token",
      async ({ query: credentials, error, path }) => {
        logger.trace(
          { ruc: credentials.ruc, path },
          "retrieving sunat token...",
        );

        const token = await getSunatToken(credentials, true);
        if (!token) return error(500, "Internal Server Error");

        return { sunat_token: token };
      },
      { query: getGenericQuerySchema() },
    )
    .get(
      "/sunat-token/v2",
      async ({ query: credentials, error, path }) => {
        logger.trace(
          { ruc: credentials.ruc, path },
          "retrieving sunat token...",
        );

        const token = await getSunatToken(credentials, false);
        if (!token) return error(500, "Internal Server Error");

        return { sunat_token: token };
      },
      { query: getGenericQuerySchema() },
    );

  app
    .use(
      pluginGracefulServer({
        onShutdown: async () => {
          if (browser) {
            logger.debug("closing browser...");
            await browser.close();
            browser = undefined;
            return;
          }

          logger.debug("browser was already closed!");
        },
      }),
    )
    .listen({ port: process.env.PORT || 8750, idleTimeout: 50 }, (c) =>
      logger.debug(`listening on port ${c.port}`),
    );
};

await main();
