import { projectMembers, projects, users } from "@furan/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";
import { listAccessibleProjectIds } from "../src/lib/project-membership.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

d("listAccessibleProjectIds", () => {
  let h: TestApp;
  let adminId: string;
  let editorId: string;
  let guestId: string;
  let projectAId: string;

  beforeAll(async () => {
    h = await createTestApp();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.db.delete(projectMembers);
    await h.db.delete(projects);
    await h.db.delete(users);

    const [admin] = await h.db
      .insert(users)
      .values({
        email: "pm-admin@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "A",
        lastName: "D",
        role: "admin",
        isActive: true,
      })
      .returning();
    const [editor] = await h.db
      .insert(users)
      .values({
        email: "pm-editor@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "E",
        lastName: "D",
        role: "editor",
        isActive: true,
      })
      .returning();
    const [guest] = await h.db
      .insert(users)
      .values({
        email: "pm-guest@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "G",
        lastName: "U",
        role: "guest",
        isActive: true,
      })
      .returning();
    const [projA] = await h.db
      .insert(projects)
      .values({ name: "pm-project-a" })
      .returning();
    await h.db.insert(projects).values({ name: "pm-project-b" });
    await h.db
      .insert(projectMembers)
      .values({ userId: editor.id, projectId: projA.id });

    adminId = admin.id;
    editorId = editor.id;
    guestId = guest.id;
    projectAId = projA.id;
  });

  test("admin sees every project", async () => {
    const ids = await listAccessibleProjectIds(h.db, {
      id: adminId,
      role: "admin",
    });
    expect(ids).toHaveLength(2);
  });

  test("editor sees only projects they are a member of", async () => {
    const ids = await listAccessibleProjectIds(h.db, {
      id: editorId,
      role: "editor",
    });
    expect(ids).toEqual([projectAId]);
  });

  test("guest sees nothing", async () => {
    const ids = await listAccessibleProjectIds(h.db, {
      id: guestId,
      role: "guest",
    });
    expect(ids).toEqual([]);
  });
});
