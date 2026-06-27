import { isAtLeastAdmin, isOwner } from "../lib/roles.js";
import type { UserRole } from "../plugins/auth.js";

type TargetState = { role: UserRole; isActive: boolean };
type UpdateFields = {
  role?: UserRole | undefined;
  isActive?: boolean | undefined;
};

export interface UserUpdateGuardInput {
  /** The authenticated admin/owner performing the change. */
  actorId: string;
  /** The actor's CURRENT role (from the DB-derived auth snapshot, never the
   * request) — gates the owner-protection rule. */
  actorRole: UserRole;
  /** The target user's CURRENT state (from the DB, not the request). */
  target: { id: string } & TargetState;
  /** The requested changes (only the fields present are applied). */
  update: UpdateFields;
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
 * Whether `update` would strip the target's ACTIVE access for the tier matched
 * by `hasTier` — i.e. the target currently holds that tier and is active, and
 * the change demotes them below it or deactivates them. One parameterized
 * source of truth for both the admin-capable and the owner invariants (and the
 * route's "do we need the count query / atomic guard" decision), so they can't
 * drift.
 */
function removesActiveAccess(
  target: TargetState,
  update: UpdateFields,
  hasTier: (role: UserRole) => boolean,
): boolean {
  const targetHasTier = hasTier(target.role) && target.isActive;
  const removesTier =
    (update.role !== undefined && !hasTier(update.role)) ||
    update.isActive === false;
  return targetHasTier && removesTier;
}

/**
 * Whether `update` mutates an OWNER target's role or active status in EITHER
 * direction — demote-below-owner, deactivate, OR reactivate — regardless of the
 * target's current active status. The trigger for owner-protection: only an
 * owner may touch another owner's standing (active-status is ignored so an
 * admin can neither quietly demote an inactive owner nor resurrect a
 * deactivated one without owner sign-off). Name-only edits don't trigger it.
 */
function affectsOwnerStatus(
  target: TargetState,
  update: UpdateFields,
): boolean {
  const touchesOwnerStanding =
    (update.role !== undefined && !isOwner(update.role)) ||
    update.isActive !== undefined;
  return isOwner(target.role) && touchesOwnerStanding;
}

/**
 * Authorization invariants for `PATCH /users/:id`. Pure + deterministic so the
 * security logic is unit-testable without a DB; the route supplies the
 * DB-derived `otherActiveAdminCount` / `otherActiveOwnerCount`.
 *
 * Layered intentionally (most-specific authorization first, then integrity):
 * - Self-protection (friendly, common footgun): a caller can neither deactivate
 *   nor change the role of their own account (so no self-promotion to owner).
 * - Owner-protection (separation of duties): only an owner may demote,
 *   deactivate, or reactivate an owner; a non-owner acting on an owner is
 *   rejected `403`.
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

  // Owner-protection: only an owner may demote/deactivate/reactivate an owner.
  // A non-owner acting on an owner target is unauthorized (checked before the
  // integrity invariants — a non-owner shouldn't even learn whether it's the
  // last owner).
  if (affectsOwnerStatus(target, update) && !isOwner(actorRole)) {
    return { ok: false, status: 403, error: "owner_protected" };
  }

  // Last-active-owner invariant (fast path): if this change would strip the
  // target's active-owner status, at least one OTHER active owner must remain.
  // The route ALSO enforces this atomically in the UPDATE to close the
  // read-then-write race (two owners demoting each other concurrently).
  if (
    removesActiveAccess(target, update, isOwner) &&
    otherActiveOwnerCount === 0
  ) {
    return { ok: false, status: 409, error: "last_owner" };
  }

  // Last-active-admin invariant (fast path): if this change would strip the
  // target's active admin-capable status, at least one OTHER active
  // admin-capable user (admin or owner) must remain.
  if (
    removesActiveAccess(target, update, isAtLeastAdmin) &&
    otherActiveAdminCount === 0
  ) {
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
  target: TargetState,
  update: UpdateFields,
): boolean {
  return removesActiveAccess(target, update, isAtLeastAdmin);
}

/**
 * Whether a pending update could remove the target's active-owner status — i.e.
 * whether the route needs to run the owner-count query + atomic owner guard.
 */
export function updateMayRemoveOwner(
  target: TargetState,
  update: UpdateFields,
): boolean {
  return removesActiveAccess(target, update, isOwner);
}
