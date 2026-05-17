import { getEnv } from "@furan/config";
import { createRedisConnection } from "@furan/queue";
import { bootstrapTelemetry } from "@furan/telemetry";

import { envSchema } from "./env.js";
import { buildFastify } from "./fastify.js";
import { startHealthServer } from "./health.js";
import { startRunEventsSubscriber } from "./run-events/subscriber.js";

async function main(): Promise<void> {
  const env = getEnv(envSchema);
  const telemetry = bootstrapTelemetry({
    service: "integrations",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });

  // Primary connection — reserved for future request-path work (rate-limit
  // counters, idempotency keys for outbound deliveries in T9, etc.).
  const redis = createRedisConnection();
  // Pub/Sub requires a dedicated client because subscribe-mode blocks
  // normal commands on the same connection.
  const redisSub = createRedisConnection();

  const app = await buildFastify({ env, telemetry });

  const health = startHealthServer({
    port: env.HEALTH_PORT,
    telemetry,
    // T7: always-ready. T8/T9 should swap in a real probe (Redis ping,
    // GitHub App JWT mint check, etc.).
    ready: async () => true,
  });

  const runEvents = startRunEventsSubscriber(redisSub, telemetry.logger);

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.logger.info({ signal }, "shutting_down");
    try {
      await app.close();
      await runEvents.close();
      await new Promise<void>((res) => health.close(() => res()));
      redisSub.disconnect();
      redis.disconnect();
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
  console.error(err);
  process.exit(1);
});
