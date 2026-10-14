import type { AppRouter } from "@furan/api/trpc";
import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

/**
 * Typed React Query hooks (e.g. `trpc.runs.getById.useQuery(...)`).
 * Type-only import of the AppRouter avoids any runtime coupling to
 * the API server bundle.
 */
export const trpc = createTRPCReact<AppRouter>();

/** Inferred tRPC procedure outputs — derive view types from these, not by hand. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Inferred tRPC procedure inputs — derive mutation argument types from these. */
export type RouterInputs = inferRouterInputs<AppRouter>;
