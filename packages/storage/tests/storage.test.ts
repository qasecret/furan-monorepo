import { Buffer } from "node:buffer";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createStorage, objectKey, type Storage } from "../src/index.js";

describe("@furan/storage", () => {
  let storage: Storage;
  const testKey = "test-" + Date.now() + ".bin";
  const testBytes = Buffer.from("hello furan storage", "utf-8");

  beforeAll(() => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long";
    storage = createStorage();
  });

  afterAll(async () => {
    try {
      await storage.delete(testKey);
    } catch {
      /* ignore */
    }
  });

  test("objectKey is deterministic SHA-256 hex", () => {
    const a = objectKey(Buffer.from("abc"));
    const b = objectKey(Buffer.from("abc"));
    const c = objectKey(Buffer.from("abd"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("put → head → get → delete round-trip", async () => {
    await storage.put(testKey, testBytes, "application/octet-stream");

    const head = await storage.head(testKey);
    expect(head).not.toBeNull();
    expect(head?.size).toBe(testBytes.length);

    const got = await storage.get(testKey);
    expect(Buffer.from(got).equals(testBytes)).toBe(true);

    await storage.delete(testKey);
    const headAfter = await storage.head(testKey);
    expect(headAfter).toBeNull();
  });

  test("head on missing key returns null, does NOT throw", async () => {
    const h = await storage.head("does-not-exist-" + Date.now());
    expect(h).toBeNull();
  });

  test("putMultipart round-trips a 10 MB buffer", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024, 0x42);
    const bigKey = "test-multipart-" + Date.now() + ".bin";
    try {
      await storage.putMultipart(bigKey, big);
      const head = await storage.head(bigKey);
      expect(head?.size).toBe(big.length);

      const got = await storage.get(bigKey);
      expect(got.length).toBe(big.length);
      expect(got[0]).toBe(0x42);
    } finally {
      try {
        await storage.delete(bigKey);
      } catch {
        /* ignore */
      }
    }
  }, 30000);
});
