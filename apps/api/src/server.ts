import { getEnv } from "@furan/config";
import {
  bootstrapTelemetry,
  installProcessErrorHandlers,
  logStartupFatal,
} from "@furan/telemetry";

import { envSchema } from "./env.js";
import { maybeBootstrapAdmin } from "./lib/bootstrap-admin.js";
import { createApiRuntime } from "./runtime.js";

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
  const runtime = await createApiRuntime({ env, telemetry });
  const { app } = runtime;

  // First-admin bootstrap. Runs at most once (no-op when users exist).
  // Never throws — operator can fall back to `seed-admin` CLI if it fails.
  await maybeBootstrapAdmin(app.db, env, app.log);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await runtime.close();
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
