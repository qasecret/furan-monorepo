import { describe, expect, it } from "vitest";

import type { UserRole } from "../src/plugins/auth.js";
import {
  checkUserUpdateGuards,
  type UserUpdateGuardInput,
  updateMayRemoveAdmin,
  updateMayRemoveOwner,
} from "../src/routes/users-admin-guards.js";

const OWNER_A = "00000000-0000-0000-0000-0000000000aa";
const OWNER_B = "00000000-0000-0000-0000-0000000000bb";
const ADMIN_A = "11111111-1111-1111-1111-111111111111";
const ADMIN_B = "22222222-2222-2222-2222-222222222222";
const EDITOR = "33333333-3333-3333-3333-333333333333";

const active = (id: string, role: UserRole) =>
  ({ id, role, isActive: true }) as const;
const activeAdmin = (id: string) => active(id, "admin");
const activeEditor = (id: string) => active(id, "editor");
const activeOwner = (id: string) => active(id, "owner");

/**
 * Calls the guard with safe defaults (admin actor, plenty of other
 * admins/owners) so each case only states the fields it exercises.
 */
function guard(
  input: Pick<UserUpdateGuardInput, "actorId" | "target" | "update"> &
    Partial<UserUpdateGuardInput>,
) {
  return checkUserUpdateGuards({
    actorRole: "admin",
    otherActiveAdminCount: 1,
    otherActiveOwnerCount: 1,
    ...input,
  });
}

describe("checkUserUpdateGuards — admin invariants", () => {
  it("allows promoting an editor to admin", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: activeEditor(EDITOR),
        update: { role: "admin" },
      }),
    ).toEqual({ ok: true });
  });

  it("allows an admin to demote ANOTHER admin when others remain", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_B),
        update: { role: "editor" },
        otherActiveAdminCount: 1, // ADMIN_A still admin
      }),
    ).toEqual({ ok: true });
  });

  it("blocks an admin from changing their OWN role (strict)", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_A),
        update: { role: "editor" },
        otherActiveAdminCount: 5,
      }),
    ).toEqual({ ok: false, status: 400, error: "cannot_change_own_role" });
  });

  it("allows a no-op self role set (same role)", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_A),
        update: { role: "admin" },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("blocks an admin from deactivating themselves", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_A),
        update: { isActive: false },
        otherActiveAdminCount: 5,
      }),
    ).toEqual({ ok: false, status: 400, error: "cannot_disable_self" });
  });

  it("blocks demoting the LAST active admin (different actor, stale session)", () => {
    expect(
      guard({
        actorId: EDITOR,
        target: activeAdmin(ADMIN_A),
        update: { role: "editor" },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: false, status: 409, error: "last_admin" });
  });

  it("blocks deactivating the LAST active admin", () => {
    expect(
      guard({
        actorId: ADMIN_B,
        target: activeAdmin(ADMIN_A),
        update: { isActive: false },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: false, status: 409, error: "last_admin" });
  });

  it("does not trigger last_admin when demoting a non-admin", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: activeEditor(EDITOR),
        update: { role: "guest" },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("does not trigger last_admin when demoting an already-inactive admin", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: { id: ADMIN_B, role: "admin", isActive: false },
        update: { role: "editor" },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("allows editing names without touching role/isActive", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_A),
        update: {},
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: true });
  });
});

describe("checkUserUpdateGuards — owner separation of duties", () => {
  it("lets an admin PROMOTE an editor to owner (bootstrap path)", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        target: activeEditor(EDITOR),
        update: { role: "owner" },
      }),
    ).toEqual({ ok: true });
  });

  it("blocks an ADMIN from demoting an owner (403 owner_protected)", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        actorRole: "admin",
        target: activeOwner(OWNER_B),
        update: { role: "admin" },
        otherActiveOwnerCount: 1,
      }),
    ).toEqual({ ok: false, status: 403, error: "owner_protected" });
  });

  it("blocks an ADMIN from deactivating an owner (403 owner_protected)", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        actorRole: "admin",
        target: activeOwner(OWNER_B),
        update: { isActive: false },
        otherActiveOwnerCount: 1,
      }),
    ).toEqual({ ok: false, status: 403, error: "owner_protected" });
  });

  it("blocks an admin demoting an INACTIVE owner (owner-protection ignores active)", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        actorRole: "admin",
        target: { id: OWNER_B, role: "owner", isActive: false },
        update: { role: "editor" },
      }),
    ).toEqual({ ok: false, status: 403, error: "owner_protected" });
  });

  it("lets an OWNER demote another owner when others remain", () => {
    expect(
      guard({
        actorId: OWNER_A,
        actorRole: "owner",
        target: activeOwner(OWNER_B),
        update: { role: "admin" },
        otherActiveOwnerCount: 1,
        otherActiveAdminCount: 1,
      }),
    ).toEqual({ ok: true });
  });

  it("blocks removing the LAST active owner (409 last_owner)", () => {
    expect(
      guard({
        actorId: OWNER_A,
        actorRole: "owner",
        target: activeOwner(OWNER_B),
        update: { role: "admin" },
        otherActiveOwnerCount: 0,
        otherActiveAdminCount: 5,
      }),
    ).toEqual({ ok: false, status: 409, error: "last_owner" });
  });

  it("lets an admin edit an owner's NAME (no role/isActive change)", () => {
    expect(
      guard({
        actorId: ADMIN_A,
        actorRole: "admin",
        target: activeOwner(OWNER_B),
        update: {},
      }),
    ).toEqual({ ok: true });
  });

  it("treats an owner as admin-capable for the last-admin invariant", () => {
    // Demoting the last *admin*-roled user is fine when an owner still holds
    // admin-capable access — the route counts owners into otherActiveAdminCount.
    expect(
      guard({
        actorId: OWNER_A,
        actorRole: "owner",
        target: activeAdmin(ADMIN_A),
        update: { role: "editor" },
        otherActiveAdminCount: 1, // the owner counts here
      }),
    ).toEqual({ ok: true });
  });
});

describe("updateMayRemoveAdmin", () => {
  it("is true when an active admin is demoted", () => {
    expect(
      updateMayRemoveAdmin(
        { role: "admin", isActive: true },
        { role: "editor" },
      ),
    ).toBe(true);
  });

  it("is true when an active owner is demoted below admin", () => {
    expect(
      updateMayRemoveAdmin(
        { role: "owner", isActive: true },
        { role: "guest" },
      ),
    ).toBe(true);
  });

  it("is false when an owner is demoted only to admin (still admin-capable)", () => {
    expect(
      updateMayRemoveAdmin(
        { role: "owner", isActive: true },
        { role: "admin" },
      ),
    ).toBe(false);
  });

  it("is true when an active admin is deactivated", () => {
    expect(
      updateMayRemoveAdmin(
        { role: "admin", isActive: true },
        { isActive: false },
      ),
    ).toBe(true);
  });

  it("is false for a non-admin target", () => {
    expect(
      updateMayRemoveAdmin(
        { role: "editor", isActive: true },
        { role: "guest" },
      ),
    ).toBe(false);
  });

  it("is false when admin stays admin (name edit)", () => {
    expect(
      updateMayRemoveAdmin(
        { role: "admin", isActive: true },
        { role: "admin" },
      ),
    ).toBe(false);
  });
});

describe("updateMayRemoveOwner", () => {
  it("is true when an active owner is demoted (even to admin)", () => {
    expect(
      updateMayRemoveOwner(
        { role: "owner", isActive: true },
        { role: "admin" },
      ),
    ).toBe(true);
  });

  it("is true when an active owner is deactivated", () => {
    expect(
      updateMayRemoveOwner(
        { role: "owner", isActive: true },
        { isActive: false },
      ),
    ).toBe(true);
  });

  it("is false for a non-owner target", () => {
    expect(
      updateMayRemoveOwner(
        { role: "admin", isActive: true },
        { role: "editor" },
      ),
    ).toBe(false);
  });

  it("is false when owner stays owner (name edit)", () => {
    expect(
      updateMayRemoveOwner(
        { role: "owner", isActive: true },
        { role: "owner" },
      ),
    ).toBe(false);
  });
});
