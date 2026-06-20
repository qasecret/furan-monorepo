import {
  diffRegions,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  builds,
  users,
} from "@furan/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

d("GET /projects — name ordering", () => {
  let h: TestApp;

  beforeAll(async () => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow

    h = await createTestApp();
    await h.app.ready();
  });

  afterAll(async () => {
    await h.close();
  });

  async function wipe() {
    await h.db.delete(diffRegions);
    await h.db.delete(screenshots);
    await h.db.delete(testRuns);
    await h.db.delete(testVariations);
    await h.db.delete(builds);
    await h.db.delete(projectMembers);
    await h.db.delete(projects);
    await h.db.delete(users);
  }

  test("GET /projects returns projects name-ordered (admin branch)", async () => {
    await wipe();
    const [admin] = await h.db
      .insert(users)
      .values({
        email: "order-admin@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "O",
        lastName: "R",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin");
    const jwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });
    await h.db
      .insert(projects)
      .values([{ name: "zeta" }, { name: "alpha" }, { name: "mid" }]);

    const res = await h.app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: `Bearer ${jwt}` },
    });
    const names = (res.json() as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(["alpha", "mid", "zeta"]);
  });

  test("GET /projects returns projects name-ordered (editor/member branch)", async () => {
    await wipe();
    // Create editor user
    const [editor] = await h.db
      .insert(users)
      .values({
        email: "order-editor@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "E",
        lastName: "D",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!editor) throw new Error("editor");
    const jwt = h.app.jwt.sign({ sub: editor.id, role: "editor" });

    // Insert projects in non-alphabetical order
    const inserted = await h.db
      .insert(projects)
      .values([{ name: "zeta" }, { name: "alpha" }, { name: "mid" }])
      .returning();

    // Add editor as member of all three
    for (const proj of inserted) {
      await h.db
        .insert(projectMembers)
        .values({ projectId: proj.id, userId: editor.id });
    }

    const res = await h.app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: `Bearer ${jwt}` },
    });
    const names = (res.json() as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(["alpha", "mid", "zeta"]);
  });
});
