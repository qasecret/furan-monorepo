import { getEnv } from "@furan/config";
import { createDb } from "@furan/db";
import { createQueue, createRedisConnection } from "@furan/queue";
import {
  bootstrapTelemetry,
  installProcessErrorHandlers,
  logStartupFatal,
} from "@furan/telemetry";

import { createApp } from "./app.js";
import { envSchema } from "./env.js";
import { maybeBootstrapAdmin } from "./lib/bootstrap-admin.js";
import { createBroadcaster } from "./lib/broadcast.js";
import { createRedisMemberProjectsCache } from "./lib/member-projects-cache.js";
import { createRedisUserAuthCache } from "./lib/user-auth-cache.js";

async function main(): Promise<void> {
  const env = getEnv(envSchema);
  const telemetry = bootstrapTelemetry({
    service: "api",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });
  installProcessErrorHandlers(telemetry.logger);
  // ADR-058: connect as the RLS-subject `furan_app` role when DATABASE_URL_APP
  // is set; otherwise the owner role (bypasses RLS — backstop inactive). Log
  // which one so operators can confirm the backstop is live.
  const { db, close } = createDb(
    env.DATABASE_URL_APP !== undefined ? { url: env.DATABASE_URL_APP } : {},
  );
  telemetry.logger.info(
    { rlsSubjectRole: env.DATABASE_URL_APP !== undefined },
    env.DATABASE_URL_APP !== undefined
      ? "db_connected_as_rls_subject_role"
      : "db_connected_as_owner_rls_backstop_inactive",
  );
  const diffQueue = createQueue("diff");
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

  const app = await createApp({
    db,
    telemetry,
    env,
    diffQueue,
    broadcaster,
    cache,
    memberProjectsCache,
  });

  // First-admin bootstrap. Runs at most once (no-op when users exist).
  // Never throws — operator can fall back to `seed-admin` CLI if it fails.
  await maybeBootstrapAdmin(db, env, app.log);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await diffQueue.close();
    await broadcasterRedis.quit().catch(() => undefined);
    await cacheRedis.quit().catch(() => undefined);
    await close();
    await telemetry.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.fatal({ err }, "failed to start");
    process.exit(1);
  }
}

void main().catch((err) => {
  logStartupFatal("api", err);
  process.exit(1);
});
