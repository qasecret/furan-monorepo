import { createApiRuntime, envSchema } from "@furan/api/scale";
import { getEnv } from "@furan/config";
import { createDb, type DB } from "@furan/db";
import { createRedisConnection, type Redis } from "@furan/queue";
import { createStorage, type Storage } from "@furan/storage";
import { bootstrapTelemetry, type Registry } from "@furan/telemetry";

import type { ScaleEnv } from "../env.js";
import { pickPort } from "../ports.js";

import {
  QUEUE_PREFIX,
  RATE_LIMIT_NAMESPACE,
  REDIS_KEY_PATTERN,
} from "./constants.js";
import { applyStackEnv, type StorageLocation } from "./process-env.js";
import { guardStorage, prepareStorage } from "./storage.js";
import { Teardown, closeInOrder } from "./teardown.js";
import { releaseRedis, startWorker } from "./worker.js";

type ApiRuntime = Awaited<ReturnType<typeof createApiRuntime>>;

/** The api's Fastify instance (the runtime's types are not exported by name). */
export type ApiApp = ApiRuntime["app"];

export interface Stack {
  apiUrl: string;
  app: ApiApp;
  registries: { api: Registry; worker: Registry };
  /** Owner connection to the scratch database. */
  db: DB;
  /** General-purpose; a subscriber (P6) takes a `duplicate()` of it. */
  redis: Redis;
  storage: Storage;
  /** `run()` closes everything that was opened, newest first. */
  teardown: Teardown;
}

/** What the seed and the stack share: the scratch database, Redis and storage. */
export interface DataPlane {
  db: DB;
  redis: Redis;
  storage: Storage;
  location: StorageLocation;
  /** True when `--reuse` found the storage of a kept run (so its seed can be kept). */
  storageReused: boolean;
}

export interface DataPlaneOptions {
  storage: "s3" | "hdd";
  keep?: boolean;
  reuse?: boolean;
}

/** Deletes every Redis key the harness owns (`furan-scale:*`), and nothing else. */
async function clearScaleKeys(redis: Redis): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      REDIS_KEY_PATTERN,
      "COUNT",
      500,
    );
    if (keys.length > 0) await redis.unlink(...keys);
    cursor = next;
  } while (cursor !== "0");
}

/**
 * The part of the stack the seed needs before the api is up: the run's object
 * storage, the process environment the api and worker read, the owner
 * connection to the scratch database and a Redis connection. Everything it
 * opens is registered on `teardown`.
 *
 * Writes `process.env` (this process only) before anything reads it, and
 * clears the harness's own Redis keys, so a crashed earlier run's jobs are not
 * picked up by this run's worker.
 */
export async function openDataPlane(
  env: ScaleEnv,
  scratchUrl: string,
  opts: DataPlaneOptions,
  teardown: Teardown,
): Promise<DataPlane> {
  if (opts.storage !== env.storage) {
    throw new Error(`--storage=${opts.storage} does not match the parsed env`);
  }
  const prepared = await prepareStorage(env, scratchUrl, teardown, {
    keep: opts.keep ?? false,
    reuse: opts.reuse ?? false,
  });
  applyStackEnv(env, scratchUrl, prepared.location);

  const { db, close: closeDb } = createDb({ url: scratchUrl });
  const redis = createRedisConnection();
  // One step: the keys go while the connection is still open.
  teardown.add("clear furan-scale:* keys, close Redis and the pool", () =>
    closeInOrder(
      () => clearScaleKeys(redis),
      () => releaseRedis(redis),
      closeDb,
    ),
  );
  await clearScaleKeys(redis);

  const storage = guardStorage(createStorage(), teardown);
  return {
    db,
    redis,
    storage,
    location: prepared.location,
    storageReused: prepared.reused,
  };
}

export interface StartStackOptions extends DataPlaneOptions {
  /** Share the caller's teardown (the CLI's), so one signal closes everything. */
  teardown?: Teardown;
  /** The data plane the seed already used; opened here when omitted. */
  plane?: DataPlane;
}

/**
 * Starts the real api and the real diff worker in this process, on the scratch
 * database, the run's Redis prefix and the run's storage, and returns them with
 * what a suite needs to measure and to drive them.
 *
 * The api listens on a free loopback port (never one of FORBIDDEN_PORTS).
 */
export async function startStack(
  env: ScaleEnv,
  scratchUrl: string,
  opts: StartStackOptions,
): Promise<Stack> {
  const teardown = opts.teardown ?? new Teardown();
  const plane =
    opts.plane ?? (await openDataPlane(env, scratchUrl, opts, teardown));

  const telemetry = bootstrapTelemetry({ service: "api", version: "scale" });
  const runtime = await createApiRuntime({
    env: getEnv(envSchema),
    telemetry,
    queuePrefix: QUEUE_PREFIX,
    rateLimitNamespace: RATE_LIMIT_NAMESPACE,
  });
  teardown.add("close the api", () =>
    closeInOrder(() => runtime.close(), telemetry.shutdown),
  );

  const port = await pickPort();
  await runtime.app.listen({ host: "127.0.0.1", port });

  const worker = await startWorker(scratchUrl, teardown);

  return {
    apiUrl: `http://127.0.0.1:${port}`,
    app: runtime.app,
    registries: { api: telemetry.metrics, worker: worker.registry },
    db: plane.db,
    redis: plane.redis,
    storage: plane.storage,
    teardown,
  };
}
