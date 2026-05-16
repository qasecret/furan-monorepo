export * from "./client.js";
export * from "./scope.js";
export * as schema from "./schema/index.js";

// Re-export drizzle-orm helpers that consumers (apps/api) need.
// Per @furan/no-raw-drizzle ESLint rule, apps cannot import from
// drizzle-orm directly — they go through this re-export.
export { sql, eq, and, or, asc, desc, inArray } from "drizzle-orm";
