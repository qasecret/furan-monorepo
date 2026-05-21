import { eq, users, type DB } from "@furan/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { maybeBootstrapAdmin } from "../src/lib/bootstrap-admin.js";
import { verifyPassword } from "../src/lib/password.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL;
const desc = skip ? describe.skip : describe;

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

desc("maybeBootstrapAdmin", () => {
  let h: TestApp;
  let db: DB;

  beforeAll(async () => {
    h = await createTestApp();
    db = h.db;
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await db.delete(users);
  });

  it("no-ops when both env vars are unset", async () => {
    const log = mockLogger();
    await maybeBootstrapAdmin(db, {}, log);
    const rows = await db.select().from(users);
    expect(rows.length).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("seeds an admin when both env vars are set + users table is empty", async () => {
    const log = mockLogger();
    await maybeBootstrapAdmin(
      db,
      {
        FURAN_BOOTSTRAP_ADMIN_EMAIL: "boot@example.test",
        FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
      },
      log,
    );
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, "boot@example.test"));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.role).toBe("admin");
    expect(row.isActive).toBe(true);
    expect(row.firstName).toBe("Admin");
    expect(row.lastName).toBe("User");
    expect(
      await verifyPassword("correct-horse-battery-staple", row.hashedPassword),
    ).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ email: "boot@example.test" }),
      "bootstrap_admin_seeded",
    );
  });

  it("no-ops when users table already has rows", async () => {
    await db.insert(users).values({
      email: "existing@example.test",
      hashedPassword: "x",
      firstName: "Existing",
      lastName: "User",
      role: "admin",
    });
    const log = mockLogger();
    await maybeBootstrapAdmin(
      db,
      {
        FURAN_BOOTSTRAP_ADMIN_EMAIL: "boot@example.test",
        FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
      },
      log,
    );
    const rows = await db.select().from(users);
    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("existing@example.test");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ email: "boot@example.test" }),
      "bootstrap_admin_skipped_users_exist",
    );
  });

  it("warns + no-ops when only email is set", async () => {
    const log = mockLogger();
    await maybeBootstrapAdmin(
      db,
      { FURAN_BOOTSTRAP_ADMIN_EMAIL: "boot@example.test" },
      log,
    );
    expect(await db.select().from(users)).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hasEmail: true, hasPassword: false }),
      "bootstrap_admin_partial_env_ignored",
    );
  });

  it("warns + no-ops when only password is set", async () => {
    const log = mockLogger();
    await maybeBootstrapAdmin(
      db,
      { FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple" },
      log,
    );
    expect(await db.select().from(users)).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hasEmail: false, hasPassword: true }),
      "bootstrap_admin_partial_env_ignored",
    );
  });

  it("swallows + logs a db error without throwing", async () => {
    const brokenDb = {
      select: () => {
        throw new Error("db-down");
      },
    } as unknown as DB;
    const log = mockLogger();
    await expect(
      maybeBootstrapAdmin(
        brokenDb,
        {
          FURAN_BOOTSTRAP_ADMIN_EMAIL: "boot@example.test",
          FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
        },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ email: "boot@example.test" }),
      "bootstrap_admin_failed_continuing",
    );
  });

  it("is idempotent under concurrent calls (race on unique email)", async () => {
    const log = mockLogger();
    await Promise.all([
      maybeBootstrapAdmin(
        db,
        {
          FURAN_BOOTSTRAP_ADMIN_EMAIL: "race@example.test",
          FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
        },
        log,
      ),
      maybeBootstrapAdmin(
        db,
        {
          FURAN_BOOTSTRAP_ADMIN_EMAIL: "race@example.test",
          FURAN_BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
        },
        log,
      ),
    ]);
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, "race@example.test"));
    expect(rows.length).toBe(1);
  });
});
