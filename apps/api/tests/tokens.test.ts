import { eq, tokens, users } from "@furan/db";
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

describe("PAT lifecycle", () => {
  let h: TestApp;
  let aliceId: string;
  let aliceJwt: string;

  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.db.delete(users);
    const [alice] = await h.db
      .insert(users)
      .values({
        email: "alice@team.example",
        hashedPassword: await hashPassword("pw-not-checked-here"),
        firstName: "Alice",
        lastName: "A",
        role: "admin",
        isActive: true,
      })
      .returning();
    aliceId = alice.id;
    aliceJwt = h.app.jwt.sign({ sub: aliceId, role: "admin" });
  });

  test("POST /account/tokens returns raw token once", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/account/tokens",
      headers: { authorization: `Bearer ${aliceJwt}` },
      payload: { label: "CI - main" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; label: string; token: string };
    expect(body.token).toMatch(/^furan_pat_[0-9A-Za-z]{32}$/);
    expect(body.label).toBe("CI - main");
  });

  test("GET /account/tokens does NOT include hash or raw token", async () => {
    await h.app.inject({
      method: "POST",
      url: "/account/tokens",
      headers: { authorization: `Bearer ${aliceJwt}` },
      payload: { label: "label-A" },
    });
    const res = await h.app.inject({
      method: "GET",
      url: "/account/tokens",
      headers: { authorization: `Bearer ${aliceJwt}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    for (const item of list) {
      expect(item).not.toHaveProperty("hash");
      expect(item).not.toHaveProperty("token");
    }
  });

  test("Authorization: Bearer <pat> authenticates as token owner", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/account/tokens",
      headers: { authorization: `Bearer ${aliceJwt}` },
      payload: { label: "pat-auth-test" },
    });
    const { token } = created.json() as { token: string };

    const me = await h.app.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { id: string }).id).toBe(aliceId);
  });

  test("a PAT-authenticated request records the token's lastUsedAt", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/account/tokens",
      headers: { authorization: `Bearer ${aliceJwt}` },
      payload: { label: "last-used" },
    });
    const { id, token } = created.json() as { id: string; token: string };

    // Freshly minted token has never been used.
    const before = await h.db
      .select({ lastUsedAt: tokens.lastUsedAt })
      .from(tokens)
      .where(eq(tokens.id, id));
    expect(before[0]?.lastUsedAt).toBeNull();

    const me = await h.app.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);

    // Using the PAT must stamp last_used_at.
    const after = await h.db
      .select({ lastUsedAt: tokens.lastUsedAt })
      .from(tokens)
      .where(eq(tokens.id, id));
    expect(after[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  test("apiKey: <pat> header still works (deprecation shim)", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/account/tokens",
      headers: { authorization: `Bearer ${aliceJwt}` },
      payload: { label: "legacy-shim" },
    });
    const { token } = created.json() as { token: string };

    const me = await h.app.inject({
      method: "GET",
      url: "/users/me",
      headers: { apiKey: token },
    });
    expect(me.statusCode).toBe(200);
  });

  test("DELETE /account/tokens/:id removes own token; missing returns 404", async () => {
    const created = await h.app.inject({
      method: "POST",
      url: "/account/tokens",
      headers: { authorization: `Bearer ${aliceJwt}` },
      payload: { label: "to-delete" },
    });
    const { id } = created.json() as { id: string };

    const del = await h.app.inject({
      method: "DELETE",
      url: `/account/tokens/${id}`,
      headers: { authorization: `Bearer ${aliceJwt}` },
    });
    expect(del.statusCode).toBe(204);

    const missing = await h.app.inject({
      method: "DELETE",
      url: "/account/tokens/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${aliceJwt}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  test("no credentials → 401", async () => {
    const res = await h.app.inject({ method: "GET", url: "/account/tokens" });
    expect(res.statusCode).toBe(401);
  });
});
