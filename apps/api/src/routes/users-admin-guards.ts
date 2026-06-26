import type { UserRole } from "../plugins/auth.js";

export interface UserUpdateGuardInput {
  /** The authenticated admin performing the change. */
  actorId: string;
  /** The target user's CURRENT state (from the DB, not the request). */
  target: { id: string; role: UserRole; isActive: boolean };
  /** The requested changes (only the fields present are applied). */
  update: { role?: UserRole | undefined; isActive?: boolean | undefined };
  /**
   * Count of OTHER active admins (role='admin' AND is_active, excluding the
   * target). Read from the DB so the last-admin invariant is immune to a stale
   * JWT role claim. May be 0 when not computed (only consulted when the change
   * would remove the target's active-admin status).
   */
  otherActiveAdminCount: number;
}

export type UserUpdateGuard =
  | { ok: true }
  | { ok: false; status: number; error: string };

const ADMIN: UserRole = "admin";

/**
 * Whether `update` would strip the target's ACTIVE-ADMIN status — i.e. the
 * target is currently an active admin and the change demotes them or
 * deactivates them. Single source of truth for both the guard's last-admin
 * branch and the route's "do we need the admin-count query / atomic guard"
 * decision, so the two can't drift.
 */
function removesActiveAdminAccess(
  target: { role: UserRole; isActive: boolean },
  update: { role?: UserRole | undefined; isActive?: boolean | undefined },
): boolean {
  const targetIsActiveAdmin = target.role === ADMIN && target.isActive;
  const removesAdminAccess =
    (update.role !== undefined && update.role !== ADMIN) ||
    update.isActive === false;
  return targetIsActiveAdmin && removesAdminAccess;
}

/**
 * Authorization invariants for `PATCH /users/:id`. Pure + deterministic so the
 * security logic is unit-testable without a DB; the route supplies the
 * DB-derived `otherActiveAdminCount`.
 *
 * Layered intentionally:
 * - Self-protection (friendly, common footgun): an admin can neither
 *   deactivate nor change the role of their own account.
 * - Last-active-admin invariant (system integrity backstop, count-based so it
 *   survives stale tokens / any caller): an operation may never remove the last
 *   active admin.
 */
export function checkUserUpdateGuards(
  input: UserUpdateGuardInput,
): UserUpdateGuard {
  const { actorId, target, update, otherActiveAdminCount } = input;
  const isSelf = actorId === target.id;

  // Self can't deactivate self.
  if (isSelf && update.isActive === false) {
    return { ok: false, status: 400, error: "cannot_disable_self" };
  }

  // Self can't change their own role (strict). Same-role is a no-op, allowed.
  if (isSelf && update.role !== undefined && update.role !== target.role) {
    return { ok: false, status: 400, error: "cannot_change_own_role" };
  }

  // Last-active-admin invariant (fast path): if this change would strip the
  // target's active-admin status, at least one OTHER active admin must remain.
  // The route ALSO enforces this atomically in the UPDATE to close the
  // read-then-write race; this branch is the friendly early rejection.
  if (removesActiveAdminAccess(target, update) && otherActiveAdminCount === 0) {
    return { ok: false, status: 409, error: "last_admin" };
  }

  return { ok: true };
}

/**
 * Whether a pending update could remove the target's active-admin status — i.e.
 * whether the route needs to run the (otherwise skippable) admin-count query.
 */
export function updateMayRemoveAdmin(
  target: { role: UserRole; isActive: boolean },
  update: { role?: UserRole | undefined; isActive?: boolean | undefined },
): boolean {
  return removesActiveAdminAccess(target, update);
}
