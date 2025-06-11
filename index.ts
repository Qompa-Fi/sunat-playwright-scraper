import { pluginGracefulServer } from "graceful-server-elysia";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { Elysia, t } from "elysia";
import NodeCache from "node-cache";
import Redis from "ioredis";
import {
  createPinoLogger,
  logger as loggerMiddleware,
} from "@bogeychan/elysia-logger";

import {
  scraper,
  type GetSunatTokenResult,
  type GetSunatTokenPayload,
} from "./scraper";

if (!process.env.APP_REDIS_CONNECTION_URL) {
  throw new Error("please set the Redis connection URL");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const redis = new Redis(process.env.APP_REDIS_CONNECTION_URL, {
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

const DEFAULT_TIMEOUT_MS = 30000 * 5;
const PAYLOAD_TTL = 2400; // 40m
const RESULT_TTL = 1800; // 30m
const QUEUE_KEY = "scraping_queue";
const TICKET_PREFIX = "ticket:";
const MAX_CONCURRENT_WORKERS = process.env.MAX_CONCURRENT_WORKERS
  ? Number.parseInt(process.env.MAX_CONCURRENT_WORKERS)
  : 3;
const REUSE_TICKET_TTL_THRESHOLD = 600; // 10m

const logger = createPinoLogger({
  level: "trace",
  base: undefined,
});

const main = async () => {
  let browser: Browser | undefined;
  let activeWorkers = 0;

  const cache = new NodeCache({ stdTTL: 60 * 59 });

  const appApiKey = process.env.APP_API_KEY;
  if (!appApiKey) {
    throw new Error("please set the API key");
  }

  const resolveSunatTokens = async (
    payload: GetSunatTokenPayload,
  ): Promise<GetSunatTokenResult | null> => {
    const cacheKey = `${payload.ruc}:${payload.targets.join("%")}`;

    const cachedTokens = cache.get<GetSunatTokenResult>(cacheKey);
    if (cachedTokens) return cachedTokens;

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

    const result = await scraper.getSunatTokens(logger, browser, payload);
    if (!result) {
      logger.warn("sunat token could not be retrieved");
      return null;
    }

    logger.debug("sunat token was retrieved, saving it to cache...", {
      ...result,
    });

    const ok = cache.set(cacheKey, result);
    if (!ok) {
      logger.warn({ ruc: payload.ruc }, "token could not be set to cache");
    }

    logger.trace(`[end] ${browser.contexts().length} contexts are open...`);

    return result;
  };

  const processQueue = async () => {
    if (activeWorkers >= MAX_CONCURRENT_WORKERS) return;
    activeWorkers++;

    try {
      const ticketId = await redis.lpop(QUEUE_KEY);
      if (!ticketId) return;

      console.log("ticket id to process is...", ticketId);

      const cacheKeyPrefix = `${TICKET_PREFIX}${ticketId}`;

      const rawPayload = await redis.get(`${cacheKeyPrefix}:payload`);
      if (!rawPayload) return;

      const payload: GetSunatTokenPayload = JSON.parse(rawPayload);

      try {
        const result = await resolveSunatTokens(payload);

        if (result) {
          await redis.set(
            `${cacheKeyPrefix}:result`,
            JSON.stringify(result),
            "EX",
            RESULT_TTL,
          );
        } else {
          await redis.set(
            `${cacheKeyPrefix}:error`,
            "failed to get token",
            "EX",
            RESULT_TTL,
          );
        }
      } catch (err) {
        logger.error(
          {
            error: err instanceof Error ? err.message : JSON.stringify(err),
            ticket_id: ticketId,
          },
          "error processing ticket",
        );
        await redis.set(
          `${cacheKeyPrefix}:error`,
          "internal server error",
          "EX",
          RESULT_TTL,
        );
      }

      await sleep(800);
    } finally {
      activeWorkers--;
    }
  };

  setInterval(processQueue, 1000);

  const findExistingTicket = async (
    payload: GetSunatTokenPayload,
  ): Promise<string | null> => {
    const pattern = `${TICKET_PREFIX}*:payload`;
    const keys = await redis.keys(pattern);

    for (const key of keys) {
      const ticketId = key.split(":")[1];
      const existingPayload = await redis.get(key);

      if (!existingPayload) continue;

      const parsedPayload: GetSunatTokenPayload = JSON.parse(existingPayload);
      if (JSON.stringify(parsedPayload) === JSON.stringify(payload)) {
        // Check if the ticket has a result and if it's still valid
        const ttl = await redis.ttl(key);
        if (ttl > 0 && ttl < REUSE_TICKET_TTL_THRESHOLD) {
          const resultKey = `${TICKET_PREFIX}${ticketId}:result`;
          const result = await redis.get(resultKey);
          if (result) {
            return ticketId;
          }
        }
      }
    }

    return null;
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
    .post(
      "/create-ticket",
      async ({ body, error }) => {
        try {
          const existingTicketId = await findExistingTicket(body);
          if (existingTicketId) {
            logger.debug(
              { ticket_id: existingTicketId },
              "reusing existing ticket with same payload",
            );
            return { ticket_id: existingTicketId, status: "reused" };
          }

          const ticketId = uuidv4();

          const key = `${TICKET_PREFIX}${ticketId}:payload`;
          const payload = JSON.stringify(body);

          await redis.set(key, payload, "EX", PAYLOAD_TTL);
          await redis.rpush(QUEUE_KEY, ticketId);

          return { ticket_id: ticketId, status: "pending" };
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes("Too Many Requests")
          ) {
            return error(429, "Too Many Requests");
          }

          logger.error({ error: err }, "error creating ticket");
          return error(500, "Internal Server Error");
        }
      },
      {
        body: t.Object({
          sol_username: t.String({ minLength: 3, maxLength: 8 }),
          sol_key: t.String({ minLength: 2, maxLength: 12 }),
          ruc: t.String({ minLength: 11, maxLength: 11 }),
          targets: t.Array(
            t.Union([
              t.Literal("sire"),
              t.Literal("cpe"),
              t.Literal("unified-platform"),
            ]),
          ),
        }),
      },
    )
    .get(
      "/get-token",
      async ({ query: { ticket_id: ticketId }, error }) => {
        try {
          const cacheKeyPrefix = `${TICKET_PREFIX}${ticketId}`;

          const payloadExists = await redis.exists(`${cacheKeyPrefix}:payload`);
          if (!payloadExists) {
            return error(404, { status: "error", message: "ticket not found" });
          }

          const errorMsg = await redis.get(`${cacheKeyPrefix}:error`);
          if (errorMsg) {
            return error(500, { status: "error", message: errorMsg });
          }

          const result = await redis.get(`${cacheKeyPrefix}:result`);
          if (result) {
            return { status: "ok", sunat_token: JSON.parse(result) };
          }

          return { status: "pending", sunat_token: null };
        } catch (err: unknown) {
          logger.error(
            { error: err, ticketId },
            "Error checking ticket status",
          );
          return error(500, "Internal Server Error");
        }
      },
      {
        query: t.Object({
          ticket_id: t.String(),
        }),
      },
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
