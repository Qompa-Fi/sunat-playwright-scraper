import { pluginGracefulServer } from "graceful-server-elysia";
import { opentelemetry } from "@elysiajs/opentelemetry";
import type { Browser } from "playwright";
import type { ElysiaWS } from "elysia/ws";
import { chromium } from "playwright";
import * as Sentry from "@sentry/bun";
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

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV === "production" ? "live" : "local",
  integrations: [Sentry.bunServerIntegration()],
});

function onRedisError(err: Error) {
  if (err.message.includes("WRONGPASS")) {
    try {
      redis.disconnect();
      redis = createRedisClient();
    } catch (err) {
      console.error("error disconnecting from redis", err);
    }
  }
}

function createRedisClient() {
  if (!process.env.APP_REDIS_CONNECTION_URL) {
    throw new Error("please set the Redis connection URL");
  }

  const client = new Redis(process.env.APP_REDIS_CONNECTION_URL, {
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  client.on("error", (err) => onRedisError(err));

  return client;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let redis = createRedisClient();
// redis.on("error", (err) => onRedisError(err));

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

const ticketRetries = new Map<string, number>();

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
    useCache = true,
  ): Promise<GetSunatTokenResult | null> => {
    const cacheKey = `${payload.ruc}:${payload.targets.join("%")}`;

    if (useCache) {
      const cachedTokens = cache.get<GetSunatTokenResult>(cacheKey);
      if (cachedTokens) {
        logger.debug({ cacheKey, cachedTokens }, "Returning cached tokens");
        return cachedTokens;
      }
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

    logger.debug({ payload }, "Calling scraper.getSunatTokens");
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

    const notifyViaWs = (ticketId: string) => {
      for (const client of wsClients) {
        if (client.readyState === 1) client.send(ticketId);
      }
    };

    try {
      const ticketId = await redis.lpop(QUEUE_KEY);
      if (!ticketId) return;

      logger.info({ ticketId }, "processing ticket");

      const cacheKeyPrefix = `${TICKET_PREFIX}${ticketId}`;

      const rawPayload = await redis.get(`${cacheKeyPrefix}:payload`);
      if (!rawPayload) {
        logger.error({ ticketId }, "payload not found for ticket");
        return;
      }

      const payload: GetSunatTokenPayload = JSON.parse(rawPayload);
      logger.debug({ ticketId, payload }, "fetched payload for ticket");

      try {
        const result = await resolveSunatTokens(payload);
        logger.debug({ ticketId, result }, "result from resolveSunatTokens");

        if (result) {
          logger.debug({ ticketId, result }, "saving result to Redis");

          let retries = ticketRetries.get(ticketId) || 0;

          while (!areTargetsFulfilled(result, payload.targets) && retries < 3) {
            retries += 1;
            ticketRetries.set(ticketId, retries);
            logger.warn(
              { ticketId, retries },
              `not all requested targets could be resolved, retrying immediately (${retries}/3)`,
            );

            const retryResult = await resolveSunatTokens(payload, false);
            if (retryResult) {
              Object.assign(result, retryResult);
            }
          }
          if (areTargetsFulfilled(result, payload.targets)) {
            ticketRetries.delete(ticketId);
            await redis.set(
              `${cacheKeyPrefix}:result`,
              JSON.stringify(result),
              "EX",
              RESULT_TTL,
            );
            logger.trace({ ticketId }, "saved");

            notifyViaWs(ticketId);
          } else {
            ticketRetries.delete(ticketId);
            await redis.set(
              `${cacheKeyPrefix}:error`,
              "not all requested targets could be resolved",
              "EX",
              RESULT_TTL,
            );
            logger.warn(
              { ticketId, retries },
              "not all requested targets could be resolved after 3 retries, error set in Redis",
            );

            notifyViaWs(ticketId);
          }
        } else {
          await redis.set(
            `${cacheKeyPrefix}:error`,
            "failed to get token",
            "EX",
            RESULT_TTL,
          );
          logger.warn({ ticketId }, "failed to get token, error set in Redis");

          notifyViaWs(ticketId);
        }
      } catch (err) {
        logger.error(
          {
            error:
              err instanceof Error
                ? err.stack || err.message
                : JSON.stringify(err),
            ticket_id: ticketId,
          },
          "error processing ticket (exception)",
        );
        await redis.set(
          `${cacheKeyPrefix}:error`,
          "internal server error",
          "EX",
          RESULT_TTL,
        );

        notifyViaWs(ticketId);
      }

      await sleep(800);
    } finally {
      activeWorkers--;
    }
  };

  setInterval(processQueue, 1000);

  function areTargetsFulfilled(
    result: GetSunatTokenResult,
    targets: string[],
  ): boolean {
    return targets.every((target) => {
      if (target === "sire") return !!result.sire;
      if (target === "cpe") return !!result.cpe;
      if (target === "unified-platform") return !!result.unified_platform;
      return false;
    });
  }

  const findExistingTicket = async (
    payload: GetSunatTokenPayload,
  ): Promise<string | null> => {
    const lookupKey = `ticket-lookup:${payload.ruc}:${payload.sol_username}:${payload.sol_key}`;
    const cachedTicketId = cache.get<string>(lookupKey);
    if (cachedTicketId) {
      const resultKey = `${TICKET_PREFIX}${cachedTicketId}:result`;
      const resultRaw = await redis.get(resultKey);
      if (resultRaw) {
        const result: GetSunatTokenResult = JSON.parse(resultRaw);
        if (areTargetsFulfilled(result, payload.targets)) {
          return cachedTicketId;
        }
      }
    }
    return null;
  };

  const wsClients = new Set<ElysiaWS>();

  const app = new Elysia()
    .decorate("Sentry", Sentry)
    .use(opentelemetry())
    .onError({ as: "global" }, function captureException({ error, Sentry }) {
      Sentry.captureException(error);
    })
    .onAfterResponse(
      { as: "global" },
      // https://github.com/elysiajs/opentelemetry/issues/40#issuecomment-2585837826
      function injectAttributes({
        body,
        cookie,
        params,
        request,
        response,
        route,
        server,
        store,
        headers,
        path,
        query,
      }) {},
    )
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
              "reusing existing ticket with same payload (and fulfilled targets)",
            );
            return { ticket_id: existingTicketId, status: "reused" };
          }

          const ticketId = uuidv4();

          const key = `${TICKET_PREFIX}${ticketId}:payload`;
          const payload = JSON.stringify(body);

          await redis
            .multi()
            .set(key, payload, "EX", PAYLOAD_TTL)
            .rpush(QUEUE_KEY, ticketId)
            .exec();

          const lookupKey = `ticket-lookup:${body.ruc}:${body.sol_username}:${body.sol_key}`;
          cache.set(lookupKey, ticketId, PAYLOAD_TTL);

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
    )
    .ws("/ws", {
      open(ws) {
        wsClients.add(ws);
      },
      close(ws) {
        wsClients.delete(ws);
      },
      // read-only
      message(ws, _message) {},
    });

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
