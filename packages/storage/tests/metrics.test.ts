import { Registry } from "prom-client";
import { describe, expect, test } from "vitest";

import { instrumentStorage } from "../src/index.js";
import type { Storage } from "../src/types.js";

/** A Storage stub whose ops resolve or reject on demand. */
function stub(overrides: Partial<Storage> = {}): Storage {
  const ok = async () => undefined as never;
  return {
    put: ok,
    putMultipart: ok,
    get: async () => new Uint8Array(),
    head: async () => null,
    delete: ok,
    list: async () => [],
    ...overrides,
  };
}

async function errorCount(
  reg: Registry,
  operation: string,
  backend: string,
): Promise<number> {
  const json = await reg.getMetricsAsJSON();
  const m = json.find((x) => x.name === "furan_storage_operation_errors_total");
  const sample = m?.values.find(
    (v) => v.labels.operation === operation && v.labels.backend === backend,
  );
  return sample?.value ?? 0;
}

describe("instrumentStorage", () => {
  test("counts a thrown operation and re-throws", async () => {
    const reg = new Registry();
    const s = instrumentStorage(
      stub({
        put: async () => {
          throw new Error("bucket gone");
        },
      }),
      reg,
      "s3",
    );
    await expect(s.put("k", new Uint8Array())).rejects.toThrow("bucket gone");
    expect(await errorCount(reg, "put", "s3")).toBe(1);
  });

  test("does not count a successful operation", async () => {
    const reg = new Registry();
    const s = instrumentStorage(stub(), reg, "hdd");
    await s.put("k", new Uint8Array());
    await s.get("k");
    expect(await errorCount(reg, "put", "hdd")).toBe(0);
  });

  test("head returning null (missing object) is not an error", async () => {
    const reg = new Registry();
    const s = instrumentStorage(
      stub({ head: async () => null }),
      reg,
      "s3",
    );
    expect(await s.head("missing")).toBeNull();
    expect(await errorCount(reg, "head", "s3")).toBe(0);
  });

  test("labels distinguish operation and backend", async () => {
    const reg = new Registry();
    const boom = async () => {
      throw new Error("io");
    };
    const s = instrumentStorage(
      stub({ get: boom, delete: boom }),
      reg,
      "hdd",
    );
    await expect(s.get("k")).rejects.toThrow();
    await expect(s.delete("k")).rejects.toThrow();
    expect(await errorCount(reg, "get", "hdd")).toBe(1);
    expect(await errorCount(reg, "delete", "hdd")).toBe(1);
  });
});
