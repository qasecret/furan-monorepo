import { randomBytes } from "node:crypto";

import { SCRATCH_DATABASE, scratchUrl, type ScaleEnv } from "../env.js";

/** Where the harness's objects live. */
export type StorageLocation =
  { kind: "s3"; bucket: string } | { kind: "hdd"; root: string };

/**
 * The variables the api, the worker and `@furan/storage` read, for one run.
 * A value of `undefined` means "remove it": a shell that is set up for a dev
 * stack must not leak `DATABASE_URL_APP` or an OTLP endpoint into the harness.
 *
 * Pure apart from the new `JWT_SECRET`; `applyStackEnv` writes the result.
 */
export function stackEnv(
  env: ScaleEnv,
  scratch: string,
  location: StorageLocation,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    DATABASE_URL: scratch,
    DATABASE_URL_APP:
      env.databaseUrlApp === undefined
        ? undefined
        : scratchUrl(env.databaseUrlApp, SCRATCH_DATABASE),
    REDIS_URL: env.redisUrl,
    JWT_SECRET: randomBytes(24).toString("hex"),
    LOG_LEVEL: "warn",
    OTLP_ENDPOINT: undefined,
    STORAGE_KIND: location.kind,
  };
  if (location.kind === "s3") {
    const s3 = env.s3;
    if (s3 === undefined) throw new Error("s3 storage without SCALE_S3_*");
    out.S3_ENDPOINT = s3.endpoint;
    out.S3_BUCKET = location.bucket;
    out.S3_ACCESS_KEY = s3.accessKey;
    out.S3_SECRET_KEY = s3.secretKey;
    out.S3_REGION = s3.region;
    out.HDD_ROOT = undefined;
  } else {
    out.HDD_ROOT = location.root;
    out.S3_ENDPOINT = undefined;
    out.S3_BUCKET = undefined;
    out.S3_ACCESS_KEY = undefined;
    out.S3_SECRET_KEY = undefined;
    out.S3_REGION = undefined;
  }
  return out;
}

/** Writes `stackEnv` into this process's environment, and only this process's. */
export function applyStackEnv(
  env: ScaleEnv,
  scratch: string,
  location: StorageLocation,
): void {
  for (const [name, value] of Object.entries(
    stackEnv(env, scratch, location),
  )) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
