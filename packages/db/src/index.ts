export * from "./client.js";
export * from "./scope.js";
export * as schema from "./schema/index.js";
// Re-export schema tables/enums as named exports for direct consumption.
export * from "./schema/index.js";

// Baseline resolution helper.
export { resolveBaseline } from "./baseline.js";
export type { BaselineSource, GitRefs } from "./baseline.js";

// Re-export drizzle-orm helpers that consumers (apps/api) need.
// Per @furan/no-raw-drizzle ESLint rule, apps cannot import from
// drizzle-orm directly — they go through this re-export.
export { sql, eq, and, or, asc, desc, inArray } from "drizzle-orm";
