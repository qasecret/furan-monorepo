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

describe("POST /auth/login", () => {
  let h: TestApp;
  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.db.delete(users);
    await h.db.insert(users).values({
      email: "alice@team.example",
      hashedPassword: await hashPassword("correct-horse-battery-staple"),
      firstName: "Alice",
      lastName: "Admin",
      role: "admin",
      isActive: true,
    });
  });

  test("valid credentials → 200 + token + user", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "alice@team.example",
        password: "correct-horse-battery-staple",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      token: string;
      user: { email: string; role: string };
    };
    expect(body.token).toMatch(/\./);
    expect(body.user.email).toBe("alice@team.example");
    expect(body.user.role).toBe("admin");
  });

  test("wrong password → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "alice@team.example", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("unknown email → 401 (no enumeration)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@team.example", password: "anything" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("malformed body → 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "not-an-email", password: "x" },
    });
    expect(res.statusCode).toBe(400);
  });
});
