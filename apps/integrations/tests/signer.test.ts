import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { signPayload } from "../src/webhooks/signer.js";

describe("signPayload", () => {
  test("matches a hand-computed HMAC-SHA256 hex digest", () => {
    const expected = createHmac("sha256", "test-secret")
      .update("hello world")
      .digest("hex");
    expect(signPayload("test-secret", "hello world")).toBe(expected);
  });

  test("is deterministic for the same inputs", () => {
    const a = signPayload("k", "x");
    const b = signPayload("k", "x");
    expect(a).toBe(b);
  });

  test("returns a 64-character lowercase hex string", () => {
    const sig = signPayload("k", "x");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when the body changes", () => {
    expect(signPayload("k", "a")).not.toBe(signPayload("k", "b"));
  });

  test("changes when the secret changes", () => {
    expect(signPayload("k1", "x")).not.toBe(signPayload("k2", "x"));
  });
});
