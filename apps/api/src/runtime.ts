import { createDb } from "@furan/db";
import { createQueue, createRedisConnection, type Redis } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";
import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import type { Env } from "./env.js";
import { createBroadcaster } from "./lib/broadcast.js";
import { createRedisMemberProjectsCache } from "./lib/member-projects-cache.js";
import { createRateLimitRedis } from "./lib/rate-limit-redis.js";
import { parseTrustProxy } from "./lib/trust-proxy.js";
import { createRedisUserAuthCache } from "./lib/user-auth-cache.js";

export interface ApiRuntimeOptions {
  env: Env;
  telemetry: Telemetry;
  /**
   * BullMQ key prefix of the diff queue the api enqueues on. It must equal the
   * prefix of the worker that consumes it. Omit for BullMQ's default.
   */
  queuePrefix?: string;
  /**
   * Key namespace of the shared rate-limit store. Omit for the api's own
   * default (`furan:rl:`).
   */
  rateLimitNamespace?: string;
}

export interface ApiRuntime {
  app: FastifyInstance;
  /**
   * Close the app, the diff queue, the Redis connections and the db, in that
   * order. It does not shut `telemetry` down: the caller owns that. Safe to
   * call more than once, and it never waits on a connection that has not
   * become ready.
   */
  close(): Promise<void>;
}

/**
 * BullMQ leaves open the ioredis connection it was handed, so `close()` has to
 * release it. This captures it once it is ready and returns the function that
 * releases it, but `close()` never waits on it: a queue's `client` settles only
 * once the connection is ready (or ended), so a connection to an unreachable
 * Redis would otherwise make `close()` hang, where BullMQ's own `close()`
 * handles that state.
 */
function trackClient(owner: {
  client: Promise<{ disconnect(): void }>;
}): () => void {
  let client: { disconnect(): void } | undefined;
  let released = false;
  void owner.client.then(
    (c) => {
      client = c;
      // The connection came up after `release()` already ran: drop it now.
      if (released) c.disconnect();
    },
    () => undefined,
  );
  return () => {
    released = true;
    client?.disconnect();
  };
}

/**
 * End a connection the runtime opened. A ready one quits gracefully; any other
 * is dropped, because a QUIT on a connection that never came up would sit in
 * its offline queue and never be answered.
 */
async function releaseRedis(redis: Redis): Promise<void> {
  if (redis.status !== "ready") {
    redis.disconnect();
    return;
  }
  await redis.quit().catch(() => redis.disconnect());
}

/**
 * Assemble the api's dependencies (db, the diff queue, the broadcaster, the
 * user-auth and member-projects caches, the rate-limit store) and build the
 * Fastify app on them. `server.ts` runs it as the service; the scale harness
 * runs it in-process. It does not listen: the caller does, or injects.
 */
export async function createApiRuntime(
  opts: ApiRuntimeOptions,
): Promise<ApiRuntime> {
  const { env, telemetry } = opts;

  // ADR-058: connect as the RLS-subject `furan_app` role when DATABASE_URL_APP
  // is set; otherwise the owner role (bypasses RLS — backstop inactive). Log
  // which one so operators can confirm the backstop is live.
  const { db, close: closeDb } = createDb(
    env.DATABASE_URL_APP !== undefined ? { url: env.DATABASE_URL_APP } : {},
  );
  telemetry.logger.info(
    { rlsSubjectRole: env.DATABASE_URL_APP !== undefined },
    env.DATABASE_URL_APP !== undefined
      ? "db_connected_as_rls_subject_role"
      : "db_connected_as_owner_rls_backstop_inactive",
  );
  const diffQueue = createQueue(
    "diff",
    opts.queuePrefix ? { prefix: opts.queuePrefix } : {},
  );
  const releaseQueueClient = trackClient(diffQueue);
  // Dedicated Redis publisher connection for project-channel broadcasts.
  // The SSE route opens its own subscriber connection per subscriber.
  const broadcasterRedis = createRedisConnection();
  const broadcaster = createBroadcaster(broadcasterRedis, telemetry);

  // Dedicated connection for the per-request JWT user-auth cache (get/set/del
  // commands; separate from the broadcaster's publisher connection).
  const cacheRedis = createRedisConnection();
  const cache = createRedisUserAuthCache(cacheRedis);
  // Shares the cache connection — separate key namespace (member-project sets
  // for the storage-proxy hot path).
  const memberProjectsCache = createRedisMemberProjectsCache(cacheRedis);
  // ADR-063: dedicated fail-fast connection for the shared rate-limit store
  // (login throttling holds across replicas). NOT createRedisConnection():
  // its BullMQ-style unbounded retries would hang logins during an outage.
  const rateLimitRedis = createRateLimitRedis(telemetry.logger);

  let app: FastifyInstance | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // Every step runs even when an earlier one throws, so one failure never
      // leaks the connections after it; the first failure is rethrown.
      const steps: Array<() => Promise<void>> = [
        async () => {
          await app?.close();
        },
        async () => {
          try {
            await diffQueue.close();
          } finally {
            releaseQueueClient();
          }
        },
        () => releaseRedis(broadcasterRedis),
        () => releaseRedis(cacheRedis),
        () => releaseRedis(rateLimitRedis),
        closeDb,
      ];
      let failure: { err: unknown } | undefined;
      for (const step of steps) {
        try {
          await step();
        } catch (err) {
          failure ??= { err };
        }
      }
      if (failure) throw failure.err;
    })();
    return closing;
  };

  try {
    // ADR-063: TRUST_PROXY=true takes the left-most X-Forwarded-For entry —
    // any client can forge it unless the api is only reachable via the proxy.
    if (parseTrustProxy(env.TRUST_PROXY) === true) {
      telemetry.logger.warn(
        { trustProxy: true },
        "trust_proxy_all_hops_xff_spoofable_unless_api_only_reachable_via_proxy",
      );
    }

    app = await createApp({
      db,
      telemetry,
      env,
      diffQueue,
      broadcaster,
      cache,
      memberProjectsCache,
      rateLimitStore: {
        redis: rateLimitRedis,
        ...(opts.rateLimitNamespace !== undefined
          ? { nameSpace: opts.rateLimitNamespace }
          : {}),
      },
    });
  } catch (err) {
    // Assembly failed: nothing will call `close()`, so release what opened.
    await close().catch(() => undefined);
    throw err;
  }

  return { app, close };
}
