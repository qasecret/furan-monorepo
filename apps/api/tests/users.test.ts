import { users } from "@furan/db";
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

describe("admin user CRUD", () => {
  let h: TestApp;
  let adminId: string;
  let adminJwt: string;
  let editorJwt: string;

  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.db.delete(users);

    const [admin] = await h.db
      .insert(users)
      .values({
        email: "admin@t.example",
        hashedPassword: await hashPassword("x12345678"),
        firstName: "Ad",
        lastName: "Min",
        role: "admin",
        isActive: true,
      })
      .returning();
    const [editor] = await h.db
      .insert(users)
      .values({
        email: "editor@t.example",
        hashedPassword: await hashPassword("x12345678"),
        firstName: "Ed",
        lastName: "Itor",
        role: "editor",
        isActive: true,
      })
      .returning();
    adminId = admin.id;
    adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });
    editorJwt = h.app.jwt.sign({ sub: editor.id, role: "editor" });
  });

  test("GET /users (admin) returns list without hashedPassword", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const u of list) {
      expect(u).not.toHaveProperty("hashedPassword");
    }
  });

  test("GET /users (editor) -> 403", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${editorJwt}` },
    });
    expect(res.statusCode).toBe(403);
  });

  test("POST /users (admin) creates user", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/users",
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: {
        email: "new@t.example",
        password: "secure-pw-1",
        firstName: "New",
        lastName: "User",
        role: "editor",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { email: string };
    expect(body.email).toBe("new@t.example");
  });

  test("POST /users (admin) - duplicate email -> 409", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/users",
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: {
        email: "admin@t.example",
        password: "secure-pw-1",
        firstName: "Dup",
        lastName: "User",
        role: "editor",
      },
    });
    expect(res.statusCode).toBe(409);
  });

  test("POST /users (admin) - weak password -> 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/users",
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: {
        email: "weak@t.example",
        password: "short",
        firstName: "W",
        lastName: "K",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test("PATCH /users/:id (admin) updates role", async () => {
    const list = await h.app.inject({
      method: "GET",
      url: "/users",
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    const editorRow = (list.json() as Array<{ id: string; role: string }>).find(
      (u) => u.role === "editor",
    );
    if (!editorRow) throw new Error("editor not seeded");

    const res = await h.app.inject({
      method: "PATCH",
      url: `/users/${editorRow.id}`,
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { role: string }).role).toBe("admin");
  });

  test("PATCH /users/:id (admin) - cannot disable self", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: `/users/${adminId}`,
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("cannot_disable_self");
  });

  test("PATCH /users/:id (admin) - unknown id -> 404", async () => {
    const res = await h.app.inject({
      method: "PATCH",
      url: "/users/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${adminJwt}` },
      payload: { role: "editor" },
    });
    expect(res.statusCode).toBe(404);
  });
});
