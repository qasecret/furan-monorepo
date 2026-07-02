import { z } from "zod";

/**
 * Run lifecycle statuses — the seven standard values that
 * `test_runs.status` accepts post-migration `0008_run_status_enum`.
 *
 * Source of truth on the DB side is `packages/db/src/schema/enums.ts`
 * (`runStatusEnum`). This Zod schema mirrors it for tRPC contracts and
 * the auto-generated OpenAPI surface.
 */
export const runStatusSchema = z.enum([
  "new",
  "running",
  "passed",
  "unresolved",
  "failed",
  "aborted",
  "empty",
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * Input shape for the `runs.overrideStatus` mutation. `"default"` asks
 * the server to recompute the status from `diff_regions`.
 */
export const overrideStatusInputSchema = z.enum([
  "passed",
  "failed",
  "default",
]);
export type OverrideStatusInput = z.infer<typeof overrideStatusInputSchema>;
