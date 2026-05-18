import { createDb, type DB } from "@furan/db";
import { bootstrapTelemetry, type Telemetry } from "@furan/telemetry";
import type { FastifyInstance } from "fastify";
import { vi, type Mock } from "vitest";

import { createApp } from "../src/app.js";
import { envSchema, type Env } from "../src/env.js";
import type { DiffQueueProducer } from "../src/trpc/context.js";

export interface TestApp {
  app: FastifyInstance;
  db: DB;
  telemetry: Telemetry;
  env: Env;
  /** Spy on .add() calls. Reset via diffQueueAdd.mockReset() between tests. */
  diffQueueAdd: Mock;
  close: () => Promise<void>;
}

const DEFAULT_DATABASE_URL =
  "postgresql://furan:devpw@localhost:5433/furan_dev";
const DEFAULT_JWT_SECRET = "test_jwt_secret_at_least_32_chars_long_for_tests"; // gitleaks:allow

export interface CreateTestAppOpts {
  envOverrides?: Partial<Env>;
  skipReady?: boolean;
  /** Override the default vi.fn() diffQueue mock. */
  diffQueue?: DiffQueueProducer;
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

  const diffQueueAdd = vi.fn().mockResolvedValue({ id: "test-job-id" });
  const diffQueue: DiffQueueProducer = opts.diffQueue ?? {
    add: diffQueueAdd as unknown as DiffQueueProducer["add"],
  };

  const app = await createApp({ db, telemetry, env, diffQueue });
  if (!opts.skipReady) {
    await app.ready();
  }
  return {
    app,
    db,
    telemetry,
    env,
    diffQueueAdd,
    close: async () => {
      await app.close();
      await closeDb();
      await telemetry.shutdown();
    },
  };
}
