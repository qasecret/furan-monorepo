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
} from "drizzle-orm";
