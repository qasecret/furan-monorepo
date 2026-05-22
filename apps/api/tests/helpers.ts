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
  /**
   * Spy on `.add()` calls. Detached/inert when `opts.diffQueue` is
   * overridden. Reset via `diffQueueAdd.mockReset()` between tests.
   */
  diffQueueAdd: Mock;
  close: () => Promise<void>;
}

const DEFAULT_DATABASE_URL =
  "postgresql://furan:devpw@localhost:5433/furan_dev";
const DEFAULT_JWT_SECRET = "test_jwt_secret_at_least_32_chars_long_for_tests"; // gitleaks:allow

export interface CreateTestAppOpts {
  envOverrides?: Partial<Env>;
  /** Skip `app.ready()` so callers can register probe routes first. */
  skipReady?: boolean;
  /** Override the default vi.fn() diffQueue mock. */
  diffQueue?: DiffQueueProducer;
}

export async function createTestApp(
  opts: CreateTestAppOpts = {},
): Promise<TestApp> {
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
  process.env.JWT_SECRET ??= DEFAULT_JWT_SECRET;

  // If the host .env still has the .env.example placeholder S3 creds
  // (`devpw_must_be_long`) instead of the running MinIO's actual root
  // creds, every S3 round-trip returns SignatureDoesNotMatch and 8 tests
  // fail with no clear pointer. Auto-realign to MINIO_ROOT_* when both
  // are present — same binding the docker compose.yml uses in prod.
  if (process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD) {
    if (!process.env.S3_ACCESS_KEY || process.env.S3_ACCESS_KEY === "furan") {
      process.env.S3_ACCESS_KEY = process.env.MINIO_ROOT_USER;
    }
    if (
      !process.env.S3_SECRET_KEY ||
      process.env.S3_SECRET_KEY === "devpw_must_be_long"
    ) {
      process.env.S3_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD;
    }
  }

  const env = envSchema.parse({ ...process.env, ...(opts.envOverrides ?? {}) });
  const telemetry = bootstrapTelemetry({
    service: "api-test",
    version: "test",
  });
  const { db, close: closeDb } = createDb();

  const diffQueueAdd = vi
    .fn<DiffQueueProducer["add"]>()
    .mockResolvedValue({ id: "test-job-id" });
  const diffQueue: DiffQueueProducer = opts.diffQueue ?? { add: diffQueueAdd };

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
