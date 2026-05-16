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
const DEFAULT_JWT_SECRET = "test_jwt_secret_at_least_32_chars_long_for_tests";

export async function createTestApp(
  overrides: Partial<Env> = {},
): Promise<TestApp> {
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
  process.env.JWT_SECRET ??= DEFAULT_JWT_SECRET;

  const env = envSchema.parse({ ...process.env, ...overrides });
  const telemetry = bootstrapTelemetry({
    service: "api-test",
    version: "test",
  });
  const { db, close: closeDb } = createDb();
  const app = await createApp({ db, telemetry, env });
  await app.ready();
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
