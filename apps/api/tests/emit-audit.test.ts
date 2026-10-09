import { auditLog, createDb, inArray, type DB } from "@furan/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { emitAudit } from "../src/lib/emit-audit.js";

/** A DB whose `transaction` (emitAudit's savepoint) runs on itself. */
function fakeDb(values: (v: unknown) => Promise<void>): DB {
  const db = {
    insert: () => ({ values }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return db as unknown as DB;
}

describe("emitAudit", () => {
  it("inserts a row with the event fields", async () => {
    const values = vi.fn(async () => {});
    const logger = { error: vi.fn() };
    await emitAudit(
      fakeDb(values),
      {
        actorId: "a1",
        action: "user.updated",
        targetType: "user",
        targetId: "t1",
        metadata: { newRole: "editor" },
      },
      logger,
    );
    expect(values).toHaveBeenCalledWith({
      actorId: "a1",
      action: "user.updated",
      targetType: "user",
      targetId: "t1",
      metadata: { newRole: "editor" },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("defaults targetId and metadata to null", async () => {
    const values = vi.fn(async () => {});
    await emitAudit(
      fakeDb(values),
      { actorId: null, action: "x", targetType: "user" },
      { error: vi.fn() },
    );
    expect(values).toHaveBeenCalledWith({
      actorId: null,
      action: "x",
      targetType: "user",
      targetId: null,
      metadata: null,
    });
  });

  it("swallows a DB error and logs it (never throws)", async () => {
    const db = fakeDb(async () => {
      throw new Error("db down");
    });
    const logger = { error: vi.fn() };
    await expect(
      emitAudit(db, { actorId: "a", action: "x", targetType: "user" }, logger),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

const withDb = process.env.DATABASE_URL ? describe : describe.skip;

withDb("emitAudit inside the caller's transaction", () => {
  let db: DB;
  let close: () => Promise<void>;
  beforeAll(() => {
    ({ db, close } = createDb());
  });
  afterAll(async () => {
    await close();
  });

  it("a failed audit insert leaves the transaction usable and committable", async () => {
    // Callers pass the request-scoped transaction (ADR-058). A DB-level insert
    // failure there aborts the whole transaction, so swallowing the error is
    // not enough: the audited action must still commit.
    const marker = `emit-audit-tx-${Date.now()}`;
    const actions = [`${marker}.before`, `${marker}.bad`, `${marker}.after`];
    const logger = { error: vi.fn() };
    await db.transaction(async (tx) => {
      await emitAudit(
        tx,
        { actorId: null, action: actions[0]!, targetType: "test" },
        logger,
      );
      // target_id is a uuid column, so Postgres rejects this insert.
      await emitAudit(
        tx,
        {
          actorId: null,
          action: actions[1]!,
          targetType: "test",
          targetId: "not-a-uuid",
        },
        logger,
      );
      await emitAudit(
        tx,
        { actorId: null, action: actions[2]!, targetType: "test" },
        logger,
      );
    });

    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(inArray(auditLog.action, actions));
    await db.delete(auditLog).where(inArray(auditLog.action, actions));
    expect(rows.map((r) => r.action).sort()).toEqual(
      [actions[2], actions[0]].sort(),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
