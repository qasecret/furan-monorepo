export * from "./client.js";
export * from "./scope.js";
export * as schema from "./schema/index.js";
// Re-export schema tables/enums as named exports for direct consumption.
export * from "./schema/index.js";

// Baseline resolution + creation helpers.
export {
  resolveBaseline,
  recordBaseline,
  baselineWriteTime,
} from "./baseline.js";
export type { BaselineSource, GitRefs } from "./baseline.js";

// Run-status rollup: `recomputeRunStatus` is the ONLY writer of
// `test_runs.status` after a diff (review flow, spec §4.3). It locks the run
// row and holds the lock until the surrounding transaction commits.
export { loadRollupInputs, recomputeRunStatus } from "./review-status.js";
export type { Tx } from "./review-status.js";

// Per-step diff pipeline (spec 2026-10-23): queue a step for a diff by bumping
// its version, fail ONE step without aborting its run, heal an abort the old
// whole-run pipeline wrote once every step has a verdict, and rebuild the
// run's totals from its steps' own columns. Each takes the caller's
// transaction and locks the run first (`FOR NO KEY UPDATE`, a no-op when
// already held), so
// a caller must not have locked or written one of the run's variations or
// steps before calling: the pipeline's lock order is run -> step -> the
// step's variation.
export {
  bumpStepGenerations,
  healPipelineAbort,
  markStepDiffFailed,
  DIFF_ERROR_CODES,
} from "./step-diff.js";
export type { DiffErrorCode } from "./step-diff.js";
// `stepAwaitingDiff`, exported with the schema above, is the "still awaiting a
// diff result" predicate that `screenshots_stuck_idx` is partial on.
export {
  recomputeRunTotals,
  PRIMARY_SIGNATURE_EXCLUDED_SOURCES,
} from "./run-totals.js";

// A run's primary signature (ADR-043 §4.2), folded from its steps' signatures.
export { computePrimarySignature } from "./primary-signature.js";
export type { CheckpointSignatureInput } from "./primary-signature.js";

// Canonical branch-agnostic variation identity (ADR-054) — shared by every
// cross-branch sibling-matcher so they can't drift onto a stale column subset.
export { variationIdentityWhere } from "./variation-identity.js";
export type { VariationIdentity } from "./variation-identity.js";

// Explicit type re-export for the run-status enum (the table-exports above
// already pick up the pgEnum constant via `./schema/index.js`).
export type { RunStatus } from "./schema/enums.js";

// Re-export drizzle-orm helpers that consumers (apps/api) need.
// Per @furan/no-raw-drizzle ESLint rule, apps cannot import from
// drizzle-orm directly — they go through this re-export.
export {
  sql,
  eq,
  ne,
  and,
  or,
  asc,
  desc,
  ilike,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  lt,
  lte,
  gt,
  gte,
  count,
  exists,
  notExists,
} from "drizzle-orm";
export type { SQL } from "drizzle-orm";
