import type { UserRole } from "../plugins/auth.js";

/**
 * Role hierarchy: owner ⊇ admin ⊇ editor ⊇ guest. A single source of truth so
 * the ~dozens of admin gates don't each hard-code role comparisons (and so the
 * `owner` tier — which must satisfy every admin gate — can't be missed at one).
 */
const RANK: Record<UserRole, number> = {
  guest: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function roleRank(role: UserRole): number {
  return RANK[role];
}

/** True for admin or owner — use wherever an "admin" capability is gated.
 * Accepts a loose string so call sites holding an untyped role can pass it. */
export function isAtLeastAdmin(role: string | undefined | null): boolean {
  return role === "admin" || role === "owner";
}

export function isOwner(role: string | undefined | null): boolean {
  return role === "owner";
}
