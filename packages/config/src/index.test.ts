import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { z } from "zod";

import { getEnv, getSecret } from "./index.js";

describe("getEnv", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {};
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("parses a valid schema", () => {
    process.env.FOO = "bar";
    process.env.PORT = "4200";
    const schema = z.object({
      FOO: z.string(),
      PORT: z.coerce.number().int().positive(),
    });
    const result = getEnv(schema);
    expect(result.FOO).toBe("bar");
    expect(result.PORT).toBe(4200);
  });

  test("throws on missing required field", () => {
    const schema = z.object({ REQUIRED: z.string().min(1) });
    expect(() => getEnv(schema)).toThrow(/Invalid environment/);
    expect(() => getEnv(schema)).toThrow(/REQUIRED/);
  });

  test("does not leak the env value in the thrown message", () => {
    process.env.SECRET_VALUE = "supersecret-do-not-leak";
    const schema = z.object({ SECRET_VALUE: z.number() }); // wrong type
    try {
      getEnv(schema);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("supersecret-do-not-leak");
    }
  });
});

describe("getSecret", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {};
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns the value when set", () => {
    process.env.JWT_SECRET = "abc123";
    expect(getSecret("JWT_SECRET")).toBe("abc123");
  });

  test("throws when missing", () => {
    expect(() => getSecret("MISSING")).toThrow(/MISSING/);
  });

  test("throws when empty string", () => {
    process.env.EMPTY = "";
    expect(() => getSecret("EMPTY")).toThrow(/EMPTY/);
  });
});
