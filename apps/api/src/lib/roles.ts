/**
 * Role hierarchy helpers — the canonical implementation now lives in
 * @furan/shared-types so the API and dashboard share one source of truth
 * (owner ⊇ admin ⊇ editor ⊇ guest). Re-exported here so existing
 * `../lib/roles.js` importers keep resolving.
 */
import { isAtLeastAdmin } from "@furan/shared-types";

import type { AuthedUser } from "../plugins/auth.js";

export { isAtLeastAdmin, isOwner, roleRank } from "@furan/shared-types";

/**
 * True when the caller may use an admin-only surface: an admin-capable role
 * (admin or owner) AND a session — an API token (`furan_pat_*`) never reaches
 * an admin surface, whatever its owner's role (ADR-064 step A). The single
 * gate for admin CAPABILITIES: `requireRole` at admin rank, the tRPC
 * `requireAdmin` middleware, and inline admin checks (analytics, the
 * all-projects inbox / project list, admin project create).
 *
 * NOT for the admin project-MEMBERSHIP bypass (`requireProjectMember`, tRPC
 * `projectMember`, storage-proxy `callerCanAccessKey`), which stays role-only
 * so an admin's SDK token keeps uploading to projects the admin manages but
 * isn't a member of (project-bound tokens replace that in step B).
 *
 * Callers that need to tell "not an admin" (`forbidden`) from "admin, but via
 * an API token" (`session_required`) branch on `isAtLeastAdmin(auth.role)`
 * AFTER this returns false.
 */
export function hasAdminSurface(
  auth: Pick<AuthedUser, "role" | "via">,
): boolean {
  return isAtLeastAdmin(auth.role) && auth.via !== "pat";
}
