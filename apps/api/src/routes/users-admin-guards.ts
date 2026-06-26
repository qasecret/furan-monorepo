import { isAtLeastAdmin, isOwner } from "../lib/roles.js";
import type { UserRole } from "../plugins/auth.js";

export interface UserUpdateGuardInput {
  /** The authenticated admin/owner performing the change. */
  actorId: string;
  /** The actor's CURRENT role (from the DB-derived auth snapshot, never the
   * request) — gates the owner-protection rule. */
  actorRole: UserRole;
  /** The target user's CURRENT state (from the DB, not the request). */
  target: { id: string; role: UserRole; isActive: boolean };
  /** The requested changes (only the fields present are applied). */
  update: { role?: UserRole | undefined; isActive?: boolean | undefined };
  /**
   * Count of OTHER active ADMIN-CAPABLE users (role ∈ {admin, owner} AND
   * is_active, excluding the target). Read from the DB so the last-admin
   * invariant is immune to a stale JWT role claim. May be 0 when not computed
   * (only consulted when the change would remove the target's admin-capable
   * status). An owner counts here because owner ⊇ admin.
   */
  otherActiveAdminCount: number;
  /**
   * Count of OTHER active OWNERS (role='owner' AND is_active, excluding the
   * target). Consulted only when the change would remove the target's active
   * owner status.
   */
  otherActiveOwnerCount: number;
}

export type UserUpdateGuard =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Whether `update` would strip the target's ACTIVE ADMIN-CAPABLE status — i.e.
 * the target is currently an active admin or owner and the change demotes them
 * below admin (to editor/guest) or deactivates them. Single source of truth for
 * both the guard's last-admin branch and the route's "do we need the admin-count
 * query / atomic guard" decision, so the two can't drift.
 */
function removesActiveAdminAccess(
  target: { role: UserRole; isActive: boolean },
  update: { role?: UserRole | undefined; isActive?: boolean | undefined },
): boolean {
  const targetIsActiveAdmin = isAtLeastAdmin(target.role) && target.isActive;
  const removesAdminAccess =
    (update.role !== undefined && !isAtLeastAdmin(update.role)) ||
    update.isActive === false;
  return targetIsActiveAdmin && removesAdminAccess;
}

/**
 * Whether `update` would strip the target's ACTIVE OWNER status — the target is
 * currently an active owner and the change demotes them below owner or
 * deactivates them. Drives the last-owner invariant + the route's owner-count
 * atomic guard.
 */
function removesActiveOwnerAccess(
  target: { role: UserRole; isActive: boolean },
  update: { role?: UserRole | undefined; isActive?: boolean | undefined },
): boolean {
  const targetIsActiveOwner = isOwner(target.role) && target.isActive;
  const removesOwnerAccess =
    (update.role !== undefined && !isOwner(update.role)) ||
    update.isActive === false;
  return targetIsActiveOwner && removesOwnerAccess;
}

/**
 * Whether `update` demotes-below-owner or deactivates an OWNER target,
 * regardless of the target's active status — the trigger for owner-protection.
 * (Active-status is ignored here on purpose: an admin must not be able to
 * quietly demote an inactive owner before it can be reactivated.)
 */
function stripsOwnerStatus(
  target: { role: UserRole; isActive: boolean },
  update: { role?: UserRole | undefined; isActive?: boolean | undefined },
): boolean {
  const stripsOwner =
    (update.role !== undefined && !isOwner(update.role)) ||
    update.isActive === false;
  return isOwner(target.role) && stripsOwner;
}

/**
 * Authorization invariants for `PATCH /users/:id`. Pure + deterministic so the
 * security logic is unit-testable without a DB; the route supplies the
 * DB-derived `otherActiveAdminCount` / `otherActiveOwnerCount`.
 *
 * Layered intentionally (most-specific authorization first, then integrity):
 * - Self-protection (friendly, common footgun): a caller can neither deactivate
 *   nor change the role of their own account (so no self-promotion to owner).
 * - Owner-protection (separation of duties): only an owner may demote or
 *   deactivate an owner; an admin acting on an owner is rejected `403`.
 * - Last-active-owner invariant: an operation may never remove the last active
 *   owner (count-based; the route also enforces it atomically).
 * - Last-active-admin invariant (system integrity backstop, count-based so it
 *   survives stale tokens / any caller): an operation may never remove the last
 *   active admin-capable user (admin or owner).
 */
export function checkUserUpdateGuards(
  input: UserUpdateGuardInput,
): UserUpdateGuard {
  const {
    actorId,
    actorRole,
    target,
    update,
    otherActiveAdminCount,
    otherActiveOwnerCount,
  } = input;
  const isSelf = actorId === target.id;

  // Self can't deactivate self.
  if (isSelf && update.isActive === false) {
    return { ok: false, status: 400, error: "cannot_disable_self" };
  }

  // Self can't change their own role (strict). Same-role is a no-op, allowed.
  if (isSelf && update.role !== undefined && update.role !== target.role) {
    return { ok: false, status: 400, error: "cannot_change_own_role" };
  }

  // Owner-protection: only an owner may demote or deactivate an owner. An admin
  // acting on an owner target is unauthorized (checked before the integrity
  // invariants — a non-owner shouldn't even learn whether it's the last owner).
  if (stripsOwnerStatus(target, update) && !isOwner(actorRole)) {
    return { ok: false, status: 403, error: "owner_protected" };
  }

  // Last-active-owner invariant (fast path): if this change would strip the
  // target's active-owner status, at least one OTHER active owner must remain.
  // The route ALSO enforces this atomically in the UPDATE to close the
  // read-then-write race (two owners demoting each other concurrently).
  if (removesActiveOwnerAccess(target, update) && otherActiveOwnerCount === 0) {
    return { ok: false, status: 409, error: "last_owner" };
  }

  // Last-active-admin invariant (fast path): if this change would strip the
  // target's active admin-capable status, at least one OTHER active
  // admin-capable user (admin or owner) must remain.
  if (removesActiveAdminAccess(target, update) && otherActiveAdminCount === 0) {
    return { ok: false, status: 409, error: "last_admin" };
  }

  return { ok: true };
}

/**
 * Whether a pending update could remove the target's active admin-capable
 * status — i.e. whether the route needs to run the (otherwise skippable)
 * admin-count query + atomic guard.
 */
export function updateMayRemoveAdmin(
  target: { role: UserRole; isActive: boolean },
  update: { role?: UserRole | undefined; isActive?: boolean | undefined },
): boolean {
  return removesActiveAdminAccess(target, update);
}

/**
 * Whether a pending update could remove the target's active-owner status — i.e.
 * whether the route needs to run the owner-count query + atomic owner guard.
 */
export function updateMayRemoveOwner(
  target: { role: UserRole; isActive: boolean },
  update: { role?: UserRole | undefined; isActive?: boolean | undefined },
): boolean {
  return removesActiveOwnerAccess(target, update);
}
