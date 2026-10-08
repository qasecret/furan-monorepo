import { projectMembers, projects, users } from "@furan/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  adminJwt: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [admin] = await h.db
    .insert(users)
    .values({
      email: "admin@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ad",
      lastName: "Min",
      role: "admin",
      isActive: true,
    })
    .returning();
  if (!admin) throw new Error("admin not seeded");

  return { adminJwt: h.app.jwt.sign({ sub: admin.id, role: "admin" }) };
}

d("POST /projects — error mapping (F7)", () => {
  let h: TestApp;
  let s: Seeded;

  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
    vi.restoreAllMocks();
  });

  const create = (jwt: string, name: string) =>
    h.app.inject({
      method: "POST",
      url: "/projects",
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name, mainBranchName: "main" },
    });

  test("a duplicate project name is reported as 409 project_name_taken", async () => {
    const first = await create(s.adminJwt, "Dup");
    expect(first.statusCode).toBe(201);

    const second = await create(s.adminJwt, "Dup");
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "project_name_taken" });
  });

  // Skipped under TEST_RLS=1: this mocks `h.db.transaction`, but with RLS the
  // app-under-test uses a separate `furan_app` connection, so the mock on the
  // owner handle never fires. It validates error mapping, not RLS.
  test.skipIf(process.env.TEST_RLS === "1")(
    "a non-unique insert failure is surfaced (500), not masked as 409",
    async () => {
      // Force a DB error that is NOT a unique violation (23502 = not_null).
      // The catch block must not report this as "project_name_taken".
      const notNull = Object.assign(new Error("null value in column"), {
        code: "23502",
      });
      vi.spyOn(h.db, "transaction").mockRejectedValueOnce(notNull);

      const res = await create(s.adminJwt, "Whatever");

      expect(res.statusCode).not.toBe(409);
      expect(res.statusCode).toBe(500);
      expect(res.json()).not.toMatchObject({ code: "project_name_taken" });
    },
  );
});
