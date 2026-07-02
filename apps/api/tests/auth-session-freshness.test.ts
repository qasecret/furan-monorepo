import { eq, users } from "@furan/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";

import { createTestApp, type TestApp } from "./helpers.js";

// A valid JWT carries a `role` claim minted at login and is trusted for up to
// JWT_EXPIRY (7d). These tests assert the auth layer reflects LIVE DB state
// instead of the stale claim — demotion/deactivation takes effect on the next
// request. (REST `authenticate` path; the tRPC `softAuthenticate` path shares
// the same `loadActiveUser` helper.)
describe("JWT session freshness", () => {
  let h: TestApp;
  let userId: string;
  let staleAdminJwt: string;

  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.db.delete(users);
    const [u] = await h.db
      .insert(users)
      .values({
        email: "fresh@t.example",
        hashedPassword: await hashPassword("x12345678"),
        firstName: "Fre",
        lastName: "Sh",
        role: "admin",
        isActive: true,
      })
      .returning();
    userId = u.id;
    // Token minted while the user was an active admin — the claim we must not
    // blindly trust later.
    staleAdminJwt = h.app.jwt.sign({ sub: u.id, role: "admin" });
  });

  test("an unchanged admin token still works (role resolved from DB)", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/users", // admin-only
      headers: { authorization: `Bearer ${staleAdminJwt}` },
    });
    expect(res.statusCode).toBe(200);
  });

  test("demotion takes effect on the next request (stale admin token → 403)", async () => {
    await h.db
      .update(users)
      .set({ role: "editor" })
      .where(eq(users.id, userId));

    const res = await h.app.inject({
      method: "GET",
      url: "/users", // admin-only; fresh role is now editor
      headers: { authorization: `Bearer ${staleAdminJwt}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("deactivation takes effect on the next request (token → 403 account_inactive)", async () => {
    await h.db
      .update(users)
      .set({ isActive: false })
      .where(eq(users.id, userId));

    const res = await h.app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${staleAdminJwt}` },
    });
    // Valid token, disabled account → distinct from a bad/missing token (401).
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe("account_inactive");
  });

  test("a deleted user's token is rejected (401)", async () => {
    await h.db.delete(users).where(eq(users.id, userId));

    const res = await h.app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${staleAdminJwt}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
