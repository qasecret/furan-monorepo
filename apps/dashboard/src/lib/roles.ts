/**
 * Pure role helpers — no React / network deps, so server resolvers, client
 * components, and unit tests can all import them. Mirrors the API's role model
 * (apps/api/src/lib/roles.ts + plugins/auth.ts): owner ⊇ admin ⊇ editor ⊇ guest.
 */
export type ViewerRole = "owner" | "admin" | "editor" | "guest";

/**
 * True for admin or owner — the single predicate for every "admin surface" gate
 * so the `owner` tier can't be missed at one of the ~dozen call sites. Accepts a
 * loose value so call sites holding an untyped role can pass it.
 */
export function isAtLeastAdmin(
  role: ViewerRole | string | undefined | null,
): boolean {
  return role === "admin" || role === "owner";
}

/** True only for the top-level owner tier. */
export function isOwner(role: ViewerRole | string | undefined | null): boolean {
  return role === "owner";
}

/** Editor and up can approve/reject; guests are read-only. */
export function canReviewRole(role: ViewerRole): boolean {
  return isAtLeastAdmin(role) || role === "editor";
}
