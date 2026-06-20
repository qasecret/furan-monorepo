import { users } from "@furan/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";

import { createTestApp, type TestApp } from "./helpers.js";

const d = !process.env.DATABASE_URL ? describe.skip : describe;

d("GET /users/me", () => {
  let h: TestApp;

  beforeAll(async () => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow

    h = await createTestApp();
  });

  afterAll(async () => {
    await h.close();
  });

  async function wipe() {
    await h.db.delete(users);
  }

  test("GET /users/me returns defaultProjectId (null when unset)", async () => {
    await wipe();
    const [user] = await h.db
      .insert(users)
      .values({
        email: "me-default@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Me",
        lastName: "Default",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");
    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const res = await h.app.inject({
      method: "GET",
      url: "/users/me",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("defaultProjectId", null);
  });
});
