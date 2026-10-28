import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { boundedArray, boundedRecord } from "./bounded.js";

/** A string schema that counts how many values it was asked to parse. */
function countingString() {
  const seen = { count: 0 };
  const schema = z.string().refine(() => {
    seen.count += 1;
    return true;
  });
  return { schema, seen };
}

describe("boundedArray", () => {
  test("rejects an oversized array with one issue and parses no element", () => {
    const { schema, seen } = countingString();
    const result = boundedArray(schema, 3).safeParse(["a", "b", "c", "d"]);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: "too_big",
        type: "array",
        maximum: 3,
        message: "Array must contain at most 3 element(s)",
      }),
    ]);
    expect(seen.count).toBe(0);
  });

  test("a million bad elements cost one issue (CVE-2023-54404)", () => {
    const huge = Array.from({ length: 1_000_000 }, () => "not-a-uuid");
    const result = boundedArray(z.string().uuid(), 500).safeParse(huge);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
  });

  test("parseAsync (tRPC's path) also stops before the elements", async () => {
    const { schema, seen } = countingString();
    const result = await boundedArray(schema, 2).safeParseAsync([
      "a",
      "b",
      "c",
    ]);

    expect(result.success).toBe(false);
    expect(seen.count).toBe(0);
  });

  test("parses every element of an array within the bound", () => {
    const { schema, seen } = countingString();
    const result = boundedArray(schema, 3).safeParse(["a", "b", "c"]);

    expect(result).toEqual({ success: true, data: ["a", "b", "c"] });
    expect(seen.count).toBe(3);
  });

  test("still reports element issues within the bound", () => {
    const result = boundedArray(z.string().uuid(), 3).safeParse(["x"]);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: "invalid_string",
      path: [0],
    });
  });

  test("enforces min", () => {
    const schema = boundedArray(z.string(), 3, { min: 1 });

    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(["a"]).success).toBe(true);
  });

  test("a non-array gets z.array's invalid_type issue", () => {
    const result = boundedArray(z.string(), 3).safeParse("a");

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: "invalid_type",
      expected: "array",
    });
  });

  test("composes with optional / nullish / default inside an object", () => {
    const schema = z.object({
      a: boundedArray(z.string(), 2).optional(),
      b: boundedArray(z.string(), 2).nullish(),
      c: boundedArray(z.string(), 2).default([]),
    });

    expect(schema.parse({ b: null })).toEqual({ b: null, c: [] });
    const result = schema.safeParse({ a: ["1", "2", "3"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["a"]);
  });

  test("keeps the element types for callers", () => {
    const schema = boundedArray(z.string().uuid(), 2);

    expectTypeOf(schema._input).toEqualTypeOf<string[]>();
    expectTypeOf(schema._output).toEqualTypeOf<string[]>();
  });
});

describe("boundedRecord", () => {
  test("rejects too many keys with one issue and parses no value", () => {
    const { schema, seen } = countingString();
    const result = boundedRecord(z.string(), schema, 2, "too many").safeParse({
      a: "1",
      b: "2",
      c: "3",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: "custom", message: "too many" }),
    ]);
    expect(seen.count).toBe(0);
  });

  test("defaults the message", () => {
    const result = boundedRecord(z.string(), z.string(), 1).safeParse({
      a: "1",
      b: "2",
    });

    expect(result.error?.issues[0]?.message).toBe(
      "Object must contain at most 1 key(s)",
    );
  });

  test("parses every entry of a record within the bound", () => {
    const { schema, seen } = countingString();
    const result = boundedRecord(z.string(), schema, 2).safeParse({
      a: "1",
      b: "2",
    });

    expect(result).toEqual({ success: true, data: { a: "1", b: "2" } });
    expect(seen.count).toBe(2);
  });

  test("a non-object gets z.record's invalid_type issue", () => {
    for (const input of ["a", null, ["a", "b", "c"]]) {
      const result = boundedRecord(z.string(), z.string(), 1).safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        code: "invalid_type",
        expected: "object",
      });
    }
  });

  test("keeps the key and value types for callers", () => {
    const schema = boundedRecord(z.string(), z.number(), 2);

    expectTypeOf(schema._input).toEqualTypeOf<Record<string, number>>();
  });
});
