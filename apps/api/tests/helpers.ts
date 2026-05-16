import { createDb, type DB } from "@furan/db";
import { bootstrapTelemetry, type Telemetry } from "@furan/telemetry";
import type { FastifyInstance } from "fastify";

import { createApp } from "../src/app.js";
import { envSchema, type Env } from "../src/env.js";

export interface TestApp {
  app: FastifyInstance;
  db: DB;
  telemetry: Telemetry;
  env: Env;
  close: () => Promise<void>;
}

const DEFAULT_DATABASE_URL =
  "postgresql://furan:devpw@localhost:5433/furan_dev";
// gitleaks:allow — test-only placeholder, not a real secret
const DEFAULT_JWT_SECRET = "test_jwt_secret_at_least_32_chars_long_for_tests";

export interface CreateTestAppOpts {
  envOverrides?: Partial<Env>;
  /** Skip `app.ready()` so callers can register probe routes first. */
  skipReady?: boolean;
}

export async function createTestApp(
  opts: CreateTestAppOpts = {},
): Promise<TestApp> {
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
  process.env.JWT_SECRET ??= DEFAULT_JWT_SECRET;

  const env = envSchema.parse({ ...process.env, ...(opts.envOverrides ?? {}) });
  const telemetry = bootstrapTelemetry({
    service: "api-test",
    version: "test",
  });
  const { db, close: closeDb } = createDb();
  const app = await createApp({ db, telemetry, env });
  if (!opts.skipReady) {
    await app.ready();
  }
  return {
    app,
    db,
    telemetry,
    env,
    close: async () => {
      await app.close();
      await closeDb();
      await telemetry.shutdown();
    },
  };
}
