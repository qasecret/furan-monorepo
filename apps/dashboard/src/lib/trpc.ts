import type { AppRouter } from "@furan/api/trpc";
import { createTRPCReact } from "@trpc/react-query";

/**
 * Typed React Query hooks (e.g. `trpc.runs.getById.useQuery(...)`).
 * Type-only import of the AppRouter avoids any runtime coupling to
 * the API server bundle.
 */
export const trpc = createTRPCReact<AppRouter>();
