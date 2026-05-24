import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { createStorage } from "../src/client.js";

/**
 * Factory routing tests. The createStorage() picker is the entry point
 * every app uses, so we exercise both env shapes end-to-end (the HDD
 * branch is real-filesystem, the S3 branch we cover via the existing
 * MinIO integration test — here we just verify the schema gates).
 */
describe("createStorage() env routing", () => {
  const originalEnv = { ...process.env };
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "furan-storage-factory-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    // Reset to a known-empty env each test so prior STORAGE_KIND values
    // don't bleed across cases. We restore originalEnv keys we touched.
    for (const k of [
      "STORAGE_KIND",
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "S3_REGION",
      "HDD_ROOT",
    ]) {
      delete process.env[k];
    }
  });

  test("STORAGE_KIND defaults to s3 (preserves existing install state)", () => {
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_BUCKET = "furan-test";
    process.env.S3_ACCESS_KEY = "x";
    process.env.S3_SECRET_KEY = "y";
    // STORAGE_KIND not set — must default to s3 and succeed.
    expect(() => createStorage()).not.toThrow();
  });

  test("STORAGE_KIND=hdd requires HDD_ROOT", () => {
    process.env.STORAGE_KIND = "hdd";
    // HDD_ROOT missing → must throw with a HDD_ROOT-tagged message so
    // ops sees exactly which env var is missing.
    expect(() => createStorage()).toThrow(/HDD_ROOT/);
  });

  test("STORAGE_KIND=s3 requires S3 credentials", () => {
    process.env.STORAGE_KIND = "s3";
    expect(() => createStorage()).toThrow(/S3_/);
  });

  test("STORAGE_KIND=hdd + HDD_ROOT works and round-trips via the real filesystem", async () => {
    process.env.STORAGE_KIND = "hdd";
    process.env.HDD_ROOT = root;

    const storage = createStorage();
    const key = "factory-rt.bin";
    const body = Buffer.from("via-factory", "utf-8");
    await storage.put(key, body);

    const head = await storage.head(key);
    expect(head?.size).toBe(body.length);

    const got = await storage.get(key);
    expect(Buffer.from(got).equals(body)).toBe(true);
    await storage.delete(key);
  });

  test("STORAGE_KIND=invalid value is rejected at boot", () => {
    process.env.STORAGE_KIND = "ftp";
    expect(() => createStorage()).toThrow();
  });

  // Restore original env after the suite so other test files in the same
  // turbo run aren't surprised.
  afterAll(() => {
    process.env = { ...originalEnv };
  });
});
