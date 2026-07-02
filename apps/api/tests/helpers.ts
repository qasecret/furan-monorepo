import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDb, type DB } from "@furan/db";
import { bootstrapTelemetry, type Telemetry } from "@furan/telemetry";
import type { FastifyInstance } from "fastify";
import { vi, type Mock } from "vitest";

import { createApp } from "../src/app.js";
import { envSchema, type Env } from "../src/env.js";
import type { Broadcaster } from "../src/lib/broadcast.js";
import type { MemberProjectsCache } from "../src/lib/member-projects-cache.js";
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
  /**
   * Spy on `broadcaster.publishProjectEvent` calls. Tests that exercise
   * the producer wiring assert against this; tests that don't care about
   * broadcasts ignore it. Reset via `broadcasterPublish.mockReset()`.
   */
  broadcasterPublish: Mock;
  close: () => Promise<void>;
}

const DEFAULT_DATABASE_URL =
  "postgresql://furan:devpw@localhost:5433/furan_dev";
const DEFAULT_JWT_SECRET = "test_jwt_secret_at_least_32_chars_long_for_tests"; // gitleaks:allow

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_ENV_CANDIDATES = [
  // monorepo-root paths from apps/api/tests/helpers.ts
  resolve(HERE, "../../../infra/docker/.env"),
];

/**
 * Best-effort lookup for the running dev MinIO's root credentials. Used
 * to recover from three drift scenarios that all manifest as
 * SignatureDoesNotMatch + 500 on every S3 round-trip:
 *
 *   1. Host shell sourced the monorepo-root `.env` which still has the
 *      `.env.example` placeholder (`devpw_must_be_long`).
 *   2. Host shell sourced a stale `.env` whose value diverged from the
 *      running container.
 *   3. `infra/docker/.env` itself is stale relative to what the running
 *      MinIO container was started with (compose generates on first `up`
 *      but if the container outlives the file rewrite, they diverge).
 *
 * Source-of-truth order:
 *   (a) docker exec into a known MinIO container name — the password
 *       *literally accepted right now*.
 *   (b) Fall back to `infra/docker/.env` if docker isn't available.
 *
 * CI sets explicit env vars and has no docker socket / compose file, so
 * both lookups no-op and the test honours the shell creds.
 */
function loadMinioCredsFromRunningContainer(): {
  user?: string;
  password?: string;
  bucket?: string;
} {
  // Common dev container names: docker compose default + the compose
  // project name override. `printenv` exits non-zero if the var is unset,
  // so wrap each lookup individually.
  const candidates = ["docker-minio-1", "furan-minio-1", "minio"];
  const printenv = (container: string, name: string): string | undefined => {
    try {
      const out = execSync(`docker exec ${container} printenv ${name}`, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      })
        .toString("utf8")
        .trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  };
  for (const name of candidates) {
    const user = printenv(name, "MINIO_ROOT_USER");
    const password = printenv(name, "MINIO_ROOT_PASSWORD");
    if (!user || !password) continue;
    // MINIO_BUCKET isn't set on the minio container itself — only on
    // minio-init + the app services. Probe a sibling minio-init container
    // for it; fall back to anything we can find on the api service.
    const bucket =
      printenv("docker-minio-init-1", "MINIO_BUCKET") ??
      printenv("docker-api-1", "S3_BUCKET");
    return { user, password, bucket };
  }
  return {};
}

/**
 * Best-effort `mc mb` against the running MinIO. Idempotent (mc returns
 * non-zero if the bucket already exists; we swallow that). Used to recover
 * when the shell's S3_BUCKET names a bucket that minio-init never created
 * (compose was first brought up with a different MINIO_BUCKET value, or
 * the shell .env is stale).
 */
function ensureMinioBucket(bucket: string): void {
  const candidates = ["docker-minio-1", "furan-minio-1", "minio"];
  for (const name of candidates) {
    try {
      execSync(
        `docker exec ${name} sh -c 'mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && mc mb --ignore-existing local/${bucket} >/dev/null 2>&1'`,
        { stdio: ["ignore", "ignore", "ignore"], timeout: 3000 },
      );
      return;
    } catch {
      // try next candidate
    }
  }
}

function loadMinioCredsFromComposeEnv(): {
  user?: string;
  password?: string;
} {
  for (const path of COMPOSE_ENV_CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const user = text.match(/^MINIO_ROOT_USER=(.+)$/m)?.[1]?.trim();
      const password = text.match(/^MINIO_ROOT_PASSWORD=(.+)$/m)?.[1]?.trim();
      if (user || password) return { user, password };
    } catch {
      // unreadable .env — fall through, helpers.ts won't realign and
      // the storage-touching tests will fail loudly.
    }
  }
  return {};
}

export interface CreateTestAppOpts {
  envOverrides?: Partial<Env>;
  /** Skip `app.ready()` so callers can register probe routes first. */
  skipReady?: boolean;
  /** Override the default vi.fn() diffQueue mock. */
  diffQueue?: DiffQueueProducer;
  /**
   * Override the default vi.fn() broadcaster mock. The project-events
   * SSE integration test substitutes a real broadcaster wired to a
   * shared Redis connection so the test can verify the full pub/sub
   * path end-to-end.
   */
  broadcaster?: Broadcaster;
  /** Inject a member-project cache (storage-proxy hot path). Absent → null. */
  memberProjectsCache?: MemberProjectsCache;
}

export async function createTestApp(
  opts: CreateTestAppOpts = {},
): Promise<TestApp> {
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
  process.env.JWT_SECRET ??= DEFAULT_JWT_SECRET;

  // The running dev MinIO uses creds from `infra/docker/.env` (compose
  // generates a random MINIO_ROOT_PASSWORD on first `up`). The host shell
  // typically has the monorepo-root `.env` sourced — which carries either
  // the `.env.example` placeholder or a stale copy from a previous compose
  // generation. When the two diverge every S3 round-trip returns
  // SignatureDoesNotMatch (HTTP 403 deserialized as a 500) and the
  // sdk-routes + storage-proxy suites fail with no clear pointer.
  //
  // Resolve the conflict in favour of the running container, then fall
  // back to the compose .env. CI has no docker socket / compose file so
  // both lookups no-op and the test honours the shell creds.
  const liveCreds = loadMinioCredsFromRunningContainer();
  const liveOk = liveCreds.user && liveCreds.password;
  const composeCreds = liveOk ? liveCreds : loadMinioCredsFromComposeEnv();
  if (composeCreds.user) process.env.MINIO_ROOT_USER = composeCreds.user;
  if (composeCreds.password)
    process.env.MINIO_ROOT_PASSWORD = composeCreds.password;
  if (process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD) {
    if (!process.env.S3_ACCESS_KEY || process.env.S3_ACCESS_KEY === "furan") {
      process.env.S3_ACCESS_KEY = process.env.MINIO_ROOT_USER;
    }
    if (
      !process.env.S3_SECRET_KEY ||
      process.env.S3_SECRET_KEY === "devpw_must_be_long" ||
      // Always realign when we just loaded fresh creds from compose env:
      // a previously-shell-exported placeholder must lose to the live value.
      composeCreds.password
    ) {
      process.env.S3_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD;
    }
  }
  // S3_BUCKET realign: the shell might have a bucket name that doesn't
  // exist in the running container (e.g. `furan-dev` from a stale .env
  // when minio-init created `furan`). The minio-init container is
  // single-shot and may have exited before this bucket was named — so
  // mc-create it if needed using the realigned creds we just wrote.
  if (liveOk && process.env.S3_BUCKET) {
    ensureMinioBucket(process.env.S3_BUCKET);
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

  // Mock broadcaster — tests that exercise the producer wiring assert
  // against `broadcasterPublish`; the project-events SSE integration
  // test overrides this to a real broadcaster that hits Redis.
  const broadcasterPublish = vi.fn().mockResolvedValue(undefined);
  const broadcaster: Broadcaster =
    opts.broadcaster ??
    ({ publishProjectEvent: broadcasterPublish } as Broadcaster);

  const app = await createApp({
    db,
    telemetry,
    env,
    diffQueue,
    broadcaster,
    ...(opts.memberProjectsCache
      ? { memberProjectsCache: opts.memberProjectsCache }
      : {}),
  });
  if (!opts.skipReady) {
    await app.ready();
  }
  return {
    app,
    db,
    telemetry,
    env,
    diffQueueAdd,
    broadcasterPublish,
    close: async () => {
      await app.close();
      await closeDb();
      await telemetry.shutdown();
    },
  };
}
