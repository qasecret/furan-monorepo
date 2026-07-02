import { getEnv } from "@furan/config";
import { z } from "zod";

import { createHddStorage } from "./hdd.js";
import { createS3Storage } from "./s3.js";
import type { Storage } from "./types.js";

export type { HeadResult, Storage, StorageObject } from "./types.js";

/**
 * `STORAGE_KIND` selects the backend at boot. Defaults to `s3` to
 * preserve the install state every furan deploy has had to date —
 * single-host installs opt in to `hdd` to skip MinIO.
 *
 * The schema is a discriminated-feeling union expressed via `superRefine`
 * because zod's `discriminatedUnion` doesn't compose well with default
 * values: we need the S3 fields required ONLY when `STORAGE_KIND=s3`,
 * and `HDD_ROOT` required ONLY when `STORAGE_KIND=hdd`. The conditional
 * branch keeps the error surface readable instead of dumping every
 * possible mismatch.
 *
 * Spec: furan-design/specs/2026-05-24-hdd-storage-backend-design.md
 */
const S3_SECRET_PLACEHOLDERS = new Set(["devpw_must_be_long"]);

const storageEnv = z
  .object({
    STORAGE_KIND: z.enum(["s3", "hdd"]).default("s3"),
    // S3-only (validated below when STORAGE_KIND=s3).
    S3_ENDPOINT: z.string().url().optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),
    S3_REGION: z.string().default("us-east-1"),
    // HDD-only (validated below when STORAGE_KIND=hdd).
    HDD_ROOT: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.STORAGE_KIND === "s3") {
      for (const k of [
        "S3_ENDPOINT",
        "S3_BUCKET",
        "S3_ACCESS_KEY",
        "S3_SECRET_KEY",
      ] as const) {
        if (!val[k]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [k],
            message: `${k} is required when STORAGE_KIND=s3`,
          });
        }
      }
      // Fail closed on the shipped `.env.example` placeholder — booting S3
      // with it produces cryptic `SignatureDoesNotMatch` 500s at first write
      // instead of a clear "you forgot to set a real secret" at startup.
      // Mirrors the bootstrap-admin placeholder rejection in the api env schema.
      if (val.S3_SECRET_KEY && S3_SECRET_PLACEHOLDERS.has(val.S3_SECRET_KEY)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["S3_SECRET_KEY"],
          message:
            "S3_SECRET_KEY is still the .env.example placeholder — set the real object-storage secret",
        });
      }
    } else if (val.STORAGE_KIND === "hdd") {
      if (!val.HDD_ROOT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["HDD_ROOT"],
          message: "HDD_ROOT is required when STORAGE_KIND=hdd",
        });
      }
    }
  });

/**
 * Reads `STORAGE_KIND` and returns the matching Storage backend.
 * Validation happens up-front via the zod schema so a misconfigured
 * install fails fast at boot instead of on the first object write.
 */
export function createStorage(): Storage {
  const env = getEnv(storageEnv);
  if (env.STORAGE_KIND === "hdd") {
    return createHddStorage({ root: env.HDD_ROOT! });
  }
  // STORAGE_KIND=s3 — superRefine already guaranteed the S3 fields are
  // set, so the non-null assertions are safe and keep the call site clean.
  return createS3Storage({
    endpoint: env.S3_ENDPOINT!,
    bucket: env.S3_BUCKET!,
    accessKey: env.S3_ACCESS_KEY!,
    secretKey: env.S3_SECRET_KEY!,
    region: env.S3_REGION,
  });
}
