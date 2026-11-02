import { createDb, eq, sql, users, type DB } from "@furan/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { capturing, type CapturedStatement } from "./capturing-db.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

/** The statement counts the suites assert rest on this proxy seeing every read. */
d("capturing records every statement, inside a transaction too", () => {
  let db: DB;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db, close } = createDb());
  });
  afterAll(async () => {
    await close();
  });

  test("execute, builder selects and relational reads, on the handle and in a transaction", async () => {
    const into: CapturedStatement[] = [];
    const captured = capturing(db, into);
    const nobody = "00000000-0000-0000-0000-000000000000";

    await captured.execute(sql`select 1`);
    await captured.select({ id: users.id }).from(users).limit(1);
    await captured.query.users.findFirst({ where: eq(users.id, nobody) });
    await captured.transaction(async (tx) => {
      await tx.execute(sql`select 2`);
      await tx.selectDistinct({ id: users.id }).from(users).limit(1);
      await tx.query.users.findMany({ where: eq(users.id, nobody) });
    });

    expect(into.map((q) => (typeof q === "string" ? q : "execute"))).toEqual([
      "execute",
      "select",
      "query",
      "execute",
      "select",
      "query",
    ]);
  });
});
