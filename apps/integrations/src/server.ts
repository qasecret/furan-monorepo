import { getEnv } from "@furan/config";
import { createDb, projects } from "@furan/db";
import { createQueue, createRedisConnection } from "@furan/queue";
import {
  bootstrapTelemetry,
  installProcessErrorHandlers,
  logStartupFatal,
} from "@furan/telemetry";
import type { App } from "octokit";

import { envSchema } from "./env.js";
import { buildFastify } from "./fastify.js";
import { createGitHubApp } from "./github/app.js";
import { registerWebhookHandlers } from "./github/webhook-handlers.js";
import { startHealthServer } from "./health.js";
import { startRunEventsSubscriber } from "./run-events/subscriber.js";
import { createDlqCounter, startWebhookWorker } from "./webhooks/index.js";

/** Bound a readiness dependency check so a hung Redis/Postgres can't hang the
 *  probe. Mirrors the `withTimeout` in the api's health route. */
const PROBE_TIMEOUT_MS = 1000;
function probe<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error("probe_timeout")), PROBE_TIMEOUT_MS),
    ),
  ]);
}

async function main(): Promise<void> {
  const env = getEnv(envSchema);
  const telemetry = bootstrapTelemetry({
    service: "integrations",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });
  installProcessErrorHandlers(telemetry.logger);

  // Primary connection — reserved for future request-path work (rate-limit
  // counters, idempotency keys for outbound deliveries in T9, etc.).
  const redis = createRedisConnection();
  // Pub/Sub requires a dedicated client because subscribe-mode blocks
  // normal commands on the same connection.
  const redisSub = createRedisConnection();

  const { db, close: closeDb } = createDb();

  // T9: outbound webhook delivery pipeline. The queue is the producer
  // surface (enqueued by run-events/subscriber.ts on `run.completed`);
  // the worker drains it and POSTs signed payloads to subscribers.
  const webhookQueue = createQueue("webhook");
  const dlqCounter = createDlqCounter(telemetry.metrics);
  const webhookWorker = startWebhookWorker({
    db,
    logger: telemetry.logger,
    dlqCounter,
  });

  // GitHub App is optional in v1.0 — set all three env vars to enable.
  // The env schema's `.refine()` already rejects partial config, so here
  // we only need to check one of the three.
  let githubApp: App | undefined;
  if (
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_APP_WEBHOOK_SECRET
  ) {
    githubApp = createGitHubApp({
      GITHUB_APP_ID: env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_APP_WEBHOOK_SECRET: env.GITHUB_APP_WEBHOOK_SECRET,
    });
    registerWebhookHandlers(githubApp, db, telemetry.logger);
    telemetry.logger.info("github_app_configured");
  } else {
    telemetry.logger.warn(
      "github_app_not_configured — set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_WEBHOOK_SECRET to enable",
    );
  }

  const app = await buildFastify({
    env,
    telemetry,
    ...(githubApp !== undefined ? { githubApp } : {}),
  });

  const health = startHealthServer({
    port: env.HEALTH_PORT,
    telemetry,
    // Deep readiness: ping the primary Redis (same instance the pub/sub
    // subscriber and webhook queue depend on — the subscriber's own
    // connection is in subscribe mode and can't answer PING) + Postgres,
    // under a short timeout. Any failure → not_ready. Never throws.
    ready: async () => {
      try {
        await Promise.all([
          probe(redis.ping()),
          probe(db.select().from(projects).limit(1)),
        ]);
        return true;
      } catch (err) {
        telemetry.logger.warn({ err }, "readyz_dependency_probe_failed");
        return false;
      }
    },
  });

  const runEvents = startRunEventsSubscriber({
    redis: redisSub,
    logger: telemetry.logger,
    db,
    webhookQueue,
    ...(githubApp !== undefined ? { githubApp } : {}),
  });

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.logger.info({ signal }, "shutting_down");
    try {
      await app.close();
      await runEvents.close();
      await webhookWorker.close();
      await webhookQueue.close();
      await new Promise<void>((res) => health.close(() => res()));
      redisSub.disconnect();
      redis.disconnect();
      await closeDb();
      await telemetry.shutdown();
    } catch (err) {
      telemetry.logger.error({ err }, "shutdown_error");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ host: env.HOST, port: env.INTEGRATIONS_PORT });
    telemetry.logger.info(
      {
        fastifyPort: env.INTEGRATIONS_PORT,
        healthPort: env.HEALTH_PORT,
      },
      "integrations_started",
    );
  } catch (err) {
    telemetry.logger.fatal({ err }, "failed_to_start");
    process.exit(1);
  }
}

void main().catch((err) => {
  logStartupFatal("integrations", err);
  process.exit(1);
});
