import { getEnv } from "@furan/config";
import { createDb } from "@furan/db";
import { createRedisConnection, createWorker } from "@furan/queue";
import { createStorage } from "@furan/storage";
import { bootstrapTelemetry } from "@furan/telemetry";

import { envSchema } from "./env.js";
import { handleDiffJob } from "./handler.js";
import { startHealthServer } from "./health.js";

async function main(): Promise<void> {
  const env = getEnv(envSchema);
  const telemetry = bootstrapTelemetry({
    service: "diff-worker",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });

  const { db, close: closeDb } = createDb();
  const storage = createStorage();
  const redis = createRedisConnection();

  const worker = createWorker("diff", async (job) => {
    telemetry.logger.info(
      { jobId: job.id, projectId: job.data.projectId },
      "diff_job_received",
    );
    return handleDiffJob(job.data, telemetry.logger, { db, storage, redis });
  });

  const health = startHealthServer({
    port: env.PORT,
    telemetry,
    ready: async () => worker.isRunning(),
  });

  const shutdown = async (signal: string): Promise<void> => {
    telemetry.logger.info({ signal }, "shutting_down");
    await worker.close();
    redis.disconnect();
    await closeDb();
    await new Promise<void>((res) => health.close(() => res()));
    await telemetry.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  telemetry.logger.info({ port: env.PORT }, "diff_worker_started");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
