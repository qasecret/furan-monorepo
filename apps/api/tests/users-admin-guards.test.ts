import { describe, expect, it } from "vitest";

import {
  checkUserUpdateGuards,
  updateMayRemoveAdmin,
} from "../src/routes/users-admin-guards.js";

const ADMIN_A = "11111111-1111-1111-1111-111111111111";
const ADMIN_B = "22222222-2222-2222-2222-222222222222";
const EDITOR = "33333333-3333-3333-3333-333333333333";

const activeAdmin = (id: string) =>
  ({ id, role: "admin", isActive: true }) as const;
const activeEditor = (id: string) =>
  ({ id, role: "editor", isActive: true }) as const;

describe("checkUserUpdateGuards", () => {
  it("allows promoting an editor to admin", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_A,
        target: activeEditor(EDITOR),
        update: { role: "admin" },
        otherActiveAdminCount: 1,
      }),
    ).toEqual({ ok: true });
  });

  it("allows an admin to demote ANOTHER admin when others remain", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_B),
        update: { role: "editor" },
        otherActiveAdminCount: 1, // ADMIN_A still admin
      }),
    ).toEqual({ ok: true });
  });

  it("blocks an admin from changing their OWN role (strict)", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_A),
        update: { role: "editor" },
        otherActiveAdminCount: 5,
      }),
    ).toEqual({ ok: false, status: 400, error: "cannot_change_own_role" });
  });

  it("allows a no-op self role set (same role)", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_A),
        update: { role: "admin" },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("blocks an admin from deactivating themselves", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_A),
        update: { isActive: false },
        otherActiveAdminCount: 5,
      }),
    ).toEqual({ ok: false, status: 400, error: "cannot_disable_self" });
  });

  it("blocks demoting the LAST active admin (different actor, stale session)", () => {
    // Actor's JWT says admin but they were demoted in the DB; they try to
    // demote the last real admin. Count-based invariant catches it.
    expect(
      checkUserUpdateGuards({
        actorId: EDITOR,
        target: activeAdmin(ADMIN_A),
        update: { role: "editor" },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: false, status: 409, error: "last_admin" });
  });

  it("blocks deactivating the LAST active admin", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_B,
        target: activeAdmin(ADMIN_A),
        update: { isActive: false },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: false, status: 409, error: "last_admin" });
  });

  it("does not trigger last_admin when demoting a non-admin", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_A,
        target: activeEditor(EDITOR),
        update: { role: "guest" },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("does not trigger last_admin when demoting an already-inactive admin", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_A,
        target: { id: ADMIN_B, role: "admin", isActive: false },
        update: { role: "editor" },
        otherActiveAdminCount: 0,
      }),
    ).toEqual({ ok: true });
  });

  it("allows editing names without touching role/isActive", () => {
    expect(
      checkUserUpdateGuards({
        actorId: ADMIN_A,
        target: activeAdmin(ADMIN_A),
        update: {},
        otherActiveAdminCount: 0,
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
