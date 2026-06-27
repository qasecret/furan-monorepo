import { z } from "zod";

/**
 * Workspace role tiers — the single source of truth for the role model shared
 * by the API and the dashboard. Hierarchy: owner ⊇ admin ⊇ editor ⊇ guest.
 *
 * DB source of truth is `packages/db/src/schema/enums.ts` (`userRoleEnum`);
 * this Zod schema mirrors it for tRPC/REST contracts, and the predicates below
 * are the one place gates encode the hierarchy (so the `owner` tier can't be
 * missed at a call site, and the two apps can't drift apart).
 */
export const userRoleSchema = z.enum(["owner", "admin", "editor", "guest"]);
export type UserRole = z.infer<typeof userRoleSchema>;

const RANK: Record<UserRole, number> = {
  guest: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

/** Numeric rank for hierarchy comparisons (owner highest). */
export function roleRank(role: UserRole): number {
  return RANK[role];
}

/**
 * True for admin or owner — the single predicate for every "admin surface"
 * gate so the `owner` tier (owner ⊇ admin) can't be missed at one of the
 * ~dozen call sites. Accepts a loose value so call sites holding an untyped
 * role can pass it.
 */
export function isAtLeastAdmin(
  role: UserRole | string | undefined | null,
): boolean {
  return role === "admin" || role === "owner";
}

/** True only for the top-level owner tier. */
export function isOwner(role: UserRole | string | undefined | null): boolean {
  return role === "owner";
}

/** Editor and up can approve/reject; guests are read-only. */
export function canReviewRole(role: UserRole): boolean {
  return isAtLeastAdmin(role) || role === "editor";
}
