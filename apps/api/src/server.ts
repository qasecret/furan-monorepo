import { getEnv } from "@furan/config";
import { createDb } from "@furan/db";
import { createQueue } from "@furan/queue";
import { bootstrapTelemetry } from "@furan/telemetry";

import { createApp } from "./app.js";
import { envSchema } from "./env.js";

async function main(): Promise<void> {
  const env = getEnv(envSchema);
  const telemetry = bootstrapTelemetry({
    service: "api",
    version: process.env.GIT_SHA ?? "dev",
    ...(env.OTLP_ENDPOINT !== undefined
      ? { otlpEndpoint: env.OTLP_ENDPOINT }
      : {}),
  });
  const { db, close } = createDb();
  const diffQueue = createQueue("diff");

  const app = await createApp({ db, telemetry, env, diffQueue });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await diffQueue.close();
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

void main();
