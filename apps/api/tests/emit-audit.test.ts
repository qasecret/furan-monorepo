import type { DB } from "@furan/db";
import { describe, expect, it, vi } from "vitest";

import { emitAudit } from "../src/lib/emit-audit.js";

function fakeDb(values: (v: unknown) => Promise<void>): DB {
  return { insert: () => ({ values }) } as unknown as DB;
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
    const db = {
      insert: () => ({
        values: async () => {
          throw new Error("db down");
        },
      }),
    } as unknown as DB;
    const logger = { error: vi.fn() };
    await expect(
      emitAudit(db, { actorId: "a", action: "x", targetType: "user" }, logger),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
