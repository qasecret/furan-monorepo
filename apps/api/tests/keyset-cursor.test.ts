import { describe, expect, it } from "vitest";

import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../src/lib/keyset-cursor.js";

const ID = "00000000-0000-4000-8000-000000000001";
const b64 = (v: unknown) =>
  Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

describe("keyset cursor", () => {
  it("round-trips a microsecond-precision timestamp unchanged", () => {
    const cursor = { createdAt: "2026-01-01T00:00:00.123456Z", id: ID };
    expect(decodeKeysetCursor(encodeKeysetCursor(cursor))).toEqual(cursor);
  });

  it("returns null for a malformed cursor instead of reaching the SQL casts", () => {
    expect(decodeKeysetCursor("not-base64-json")).toBeNull();
    expect(decodeKeysetCursor(b64({ createdAt: "nope", id: ID }))).toBeNull();
    expect(
      decodeKeysetCursor(
        b64({ createdAt: "2026-01-01T00:00:00Z", id: "not-a-uuid" }),
      ),
    ).toBeNull();
    expect(decodeKeysetCursor(b64({ id: ID }))).toBeNull();
  });
});
