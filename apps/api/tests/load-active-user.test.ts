import { describe, expect, it } from "vitest";

import { loadActiveUser } from "../src/lib/load-active-user.js";

// A DB stub that throws if any query is attempted — proves the empty-id guard
// short-circuits BEFORE touching the database (a verified JWT lacking `sub`
// must degrade to null/401, not a 500 from an undefined bind). The
// active-user/demotion/deactivation behaviour is covered by the DB-backed
// integration tests in auth-session-freshness.test.ts.
const throwingDb = {
  select() {
    throw new Error("db must not be queried for an empty userId");
  },
} as unknown as Parameters<typeof loadActiveUser>[0];

describe("loadActiveUser empty-id guard", () => {
  it("returns null for an empty userId without querying the DB", async () => {
    expect(await loadActiveUser(throwingDb, "")).toBeNull();
  });

  it("returns null for an undefined userId without querying the DB", async () => {
    expect(
      await loadActiveUser(throwingDb, undefined as unknown as string),
    ).toBeNull();
  });
});
