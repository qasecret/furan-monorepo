import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createHddStorage } from "../src/hdd.js";

describe("@furan/storage HDD backend", () => {
  let root: string;
  const storage = (() => ({
    get instance() {
      return createHddStorage({ root });
    },
  }))();

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "furan-storage-hdd-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("put → head → get → delete round-trip writes a real file under root", async () => {
    const key = "round-trip.bin";
    const bytes = Buffer.from("hello hdd", "utf-8");

    await storage.instance.put(key, bytes, "application/octet-stream");

    // Real file landed under root, not anywhere else.
    const onDisk = await readFile(path.join(root, key));
    expect(onDisk.equals(bytes)).toBe(true);

    const head = await storage.instance.head(key);
    expect(head?.size).toBe(bytes.length);

    const got = await storage.instance.get(key);
    expect(Buffer.from(got).equals(bytes)).toBe(true);

    await storage.instance.delete(key);
    const headAfter = await storage.instance.head(key);
    expect(headAfter).toBeNull();
  });

  test("put auto-creates parent directories for nested keys", async () => {
    const key = "screenshots/abc/def.png";
    await storage.instance.put(key, Buffer.from([0x01, 0x02, 0x03]));

    const st = await stat(path.join(root, "screenshots", "abc", "def.png"));
    expect(st.isFile()).toBe(true);

    // The dir mkdir was recursive.
    const dirEntries = await readdir(path.join(root, "screenshots"));
    expect(dirEntries).toContain("abc");
  });

  test("head on missing key returns null, not error", async () => {
    expect(await storage.instance.head("does-not-exist.bin")).toBeNull();
  });

  test("delete on missing key is silent (matches S3 semantics)", async () => {
    await expect(
      storage.instance.delete("never-existed.bin"),
    ).resolves.toBeUndefined();
  });

  test("putMultipart writes the whole buffer in one shot (same as put)", async () => {
    const key = "multipart-big.bin";
    const big = Buffer.alloc(64 * 1024, 0x42);
    await storage.instance.putMultipart(key, big);

    const head = await storage.instance.head(key);
    expect(head?.size).toBe(big.length);
    const got = await storage.instance.get(key);
    expect(got.length).toBe(big.length);
    expect(got[0]).toBe(0x42);
  });

  test("rejects keys containing `..` to prevent path traversal", async () => {
    await expect(
      storage.instance.put("../escape.bin", Buffer.from([0])),
    ).rejects.toThrow(/storage_hdd_invalid_key/);
    await expect(storage.instance.get("../escape.bin")).rejects.toThrow(
      /storage_hdd_invalid_key/,
    );
    await expect(storage.instance.head("../escape.bin")).rejects.toThrow(
      /storage_hdd_invalid_key/,
    );
    await expect(storage.instance.delete("../escape.bin")).rejects.toThrow(
      /storage_hdd_invalid_key/,
    );
  });

  test("rejects absolute keys", async () => {
    await expect(
      storage.instance.put("/etc/passwd", Buffer.from([0])),
    ).rejects.toThrow(/storage_hdd_invalid_key/);
  });

  test("rejects nested traversal that looks deceptively-relative", async () => {
    // `subdir/../../../outside` — joined with root then resolved must not
    // escape the root.
    await expect(
      storage.instance.put("a/../../outside.bin", Buffer.from([0])),
    ).rejects.toThrow(/storage_hdd_invalid_key/);
  });

  test("rejects empty key", async () => {
    await expect(storage.instance.put("", Buffer.from([0]))).rejects.toThrow(
      /storage_hdd_invalid_key/,
    );
  });

  test("get on missing key throws ENOENT (caller's job to check head first)", async () => {
    await expect(
      storage.instance.get("nonexistent-file.bin"),
    ).rejects.toThrow();
  });
});
