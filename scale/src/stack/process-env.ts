import { randomBytes } from "node:crypto";

import { envSchema } from "@furan/api/scale";

import { SCRATCH_DATABASE, scratchUrl, type ScaleEnv } from "../env.js";

/** Where the harness's objects live. */
export type StorageLocation =
  { kind: "s3"; bucket: string } | { kind: "hdd"; root: string };

/** Every variable the api's env schema reads. */
const API_ENV_KEYS: readonly string[] = Object.keys(envSchema.shape);

/**
 * The variables the api, the worker and `@furan/storage` read, for one run.
 *
 * Every variable the api's env schema knows is in the result, so a run
 * measures the same configuration whatever shell it was started from: the
 * ones the harness sets get its value, all the others (`NODE_ENV`,
 * `TRUST_PROXY`, `SSE_MAX_CONNECTIONS`, `JWT_EXPIRY`,
 * `FURAN_DASHBOARD_ORIGIN`, a dev `DATABASE_URL_APP` or OTLP endpoint, ...)
 * are `undefined`, which means "remove it", so the schema's defaults apply.
 * The key list comes from the schema, so a variable added to it later is
 * covered without a change here.
 *
 * Pure apart from the new `JWT_SECRET`; `applyStackEnv` writes the result.
 */
export function stackEnv(
  env: ScaleEnv,
  scratch: string,
  location: StorageLocation,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of API_ENV_KEYS) out[key] = undefined;

  out.DATABASE_URL = scratch;
  out.DATABASE_URL_APP =
    env.databaseUrlApp === undefined
      ? undefined
      : scratchUrl(env.databaseUrlApp, SCRATCH_DATABASE);
  out.REDIS_URL = env.redisUrl;
  out.JWT_SECRET = randomBytes(24).toString("hex");
  out.LOG_LEVEL = "warn";

  // `@furan/storage`'s own variables (it reads the process environment too).
  out.STORAGE_KIND = location.kind;
  out.S3_REGION = undefined;
  out.HDD_ROOT = undefined;
  if (location.kind === "s3") {
    const s3 = env.s3;
    if (s3 === undefined) throw new Error("s3 storage without SCALE_S3_*");
    out.S3_ENDPOINT = s3.endpoint;
    out.S3_BUCKET = location.bucket;
    out.S3_ACCESS_KEY = s3.accessKey;
    out.S3_SECRET_KEY = s3.secretKey;
    out.S3_REGION = s3.region;
  } else {
    out.HDD_ROOT = location.root;
  }
  return out;
}

/**
 * Writes `stackEnv` into this process's environment, and only this process's
 * (`target` is for tests).
 */
export function applyStackEnv(
  env: ScaleEnv,
  scratch: string,
  location: StorageLocation,
  target: NodeJS.ProcessEnv = process.env,
): void {
  for (const [name, value] of Object.entries(
    stackEnv(env, scratch, location),
  )) {
    if (value === undefined) delete target[name];
    else target[name] = value;
  }
}
