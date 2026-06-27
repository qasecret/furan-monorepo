/**
 * Role helpers — the canonical implementation lives in @furan/shared-types so
 * the dashboard and API share one source of truth (owner ⊇ admin ⊇ editor ⊇
 * guest). Re-exported here under the dashboard's `ViewerRole` name so existing
 * `@/lib/roles` importers keep resolving.
 */
export type { UserRole as ViewerRole } from "@furan/shared-types";
export {
  canReviewRole,
  isAtLeastAdmin,
  isOwner,
  roleRank,
} from "@furan/shared-types";
