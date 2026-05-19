import { z } from "zod";

/**
 * K/V properties attached to a build. Mirrors Applitools'
 * `Configuration.addProperty(key, value)`. Constrained at the boundary:
 * 1–20 keys, key 1–64 chars matching /^[a-zA-Z0-9_.-]+$/, value ≤ 256 chars.
 */
export const buildPropertiesSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    z.string().max(256),
  )
  .refine((p) => Object.keys(p).length <= 20, {
    message: "max 20 properties per build",
  });

export type BuildProperties = z.infer<typeof buildPropertiesSchema>;

/**
 * Aggregate status for a build derived from its child runs at read time.
 * Six values — distinct from the seven-value run-status enum. There is no
 * "new" at the build level: a build whose runs are all `new` aggregates to
 * `passed` (since `new` means "passed and baseline created").
 *
 * Precedence (highest → lowest): running, unresolved, failed, aborted, passed, empty.
 */
export const buildAggregateStatusSchema = z.enum([
  "running",
  "unresolved",
  "failed",
  "aborted",
  "passed",
  "empty",
]);

export type BuildAggregateStatus = z.infer<typeof buildAggregateStatusSchema>;
