/**
 * Role hierarchy helpers — the canonical implementation now lives in
 * @furan/shared-types so the API and dashboard share one source of truth
 * (owner ⊇ admin ⊇ editor ⊇ guest). Re-exported here so existing
 * `../lib/roles.js` importers keep resolving.
 */
export { isAtLeastAdmin, isOwner, roleRank } from "@furan/shared-types";
