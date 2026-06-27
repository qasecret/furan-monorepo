export * from "./client.js";
export * from "./scope.js";
export * as schema from "./schema/index.js";
// Re-export schema tables/enums as named exports for direct consumption.
export * from "./schema/index.js";

// Baseline resolution + creation helpers.
export { resolveBaseline, recordBaseline } from "./baseline.js";
export type { BaselineSource, GitRefs } from "./baseline.js";

// Explicit type re-export for the run-status enum (the table-exports above
// already pick up the pgEnum constant via `./schema/index.js`).
export type { RunStatus } from "./schema/enums.js";

// Re-export drizzle-orm helpers that consumers (apps/api) need.
// Per @furan/no-raw-drizzle ESLint rule, apps cannot import from
// drizzle-orm directly — they go through this re-export.
export {
  sql,
  eq,
  and,
  or,
  asc,
  desc,
  ilike,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  gt,
  gte,
  count,
} from "drizzle-orm";
