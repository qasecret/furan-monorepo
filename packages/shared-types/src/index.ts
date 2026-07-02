// Cross-cutting domain types and Zod schemas land here as routes ship in
// Phase 1.C+. Phase 1.A scaffolds the package so dependents can declare
// `@furan/shared-types` workspace dependencies on day one.

import type { AnyRouter } from "@trpc/server";

export const PHASE = "1.A-skeleton" as const;

// AppRouter shape for tRPC v11. Empty in P1.C; procedures register
// in apps/api but the *type* lives here so consumers (apps/dashboard)
// can import without taking a build dependency on apps/api.
export type AppRouter = AnyRouter;

export * from "./run-status.js";
export * from "./build.js";
export * from "./region-patterns.js";
export * from "./inbox.js";
export * from "./dashboard-telemetry.js";
export * from "./auto-rules.js";
export * from "./roles.js";
export * from "./error.js";
