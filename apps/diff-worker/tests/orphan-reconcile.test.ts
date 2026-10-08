import type { Storage, StorageObject } from "@furan/storage";
import { describe, expect, test, vi } from "vitest";

import { reconcileOrphans } from "../src/orphan-reconcile.js";

/** In-memory Storage stub exposing only `list` + `delete` (the sweep's surface). */
function fakeStorage(objects: StorageObject[]): Storage {
  const del = vi.fn(async () => {});
  return {
    list: async () => objects,
    delete: del,
    // unused by the sweep
    put: async () => {},
    putMultipart: async () => {},
    get: async () => new Uint8Array(),
    head: async () => null,
  } as unknown as Storage & { delete: typeof del };
}

const NOW = new Date("2026-07-02T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("reconcileOrphans", () => {
  test("deletes only old, unreferenced objects", async () => {
    const objects: StorageObject[] = [
      { key: "referenced-old", size: 1, lastModified: hoursAgo(48) },
      { key: "referenced-new", size: 1, lastModified: hoursAgo(1) },
      { key: "orphan-old", size: 1, lastModified: hoursAgo(48) },
      { key: "orphan-recent", size: 1, lastModified: hoursAgo(2) }, // in-flight window
    ];
    const storage = fakeStorage(objects);
    const referenced = new Set(["referenced-old", "referenced-new"]);

    const res = await reconcileOrphans(storage, referenced, {
      olderThanHours: 24,
      now: NOW,
    });

    expect(res.scanned).toBe(4);
    expect(res.deletedKeys).toEqual(["orphan-old"]);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith("orphan-old");
  });

  test("dry-run reports but never deletes", async () => {
    const storage = fakeStorage([
      { key: "orphan-old", size: 1, lastModified: hoursAgo(48) },
    ]);
    const res = await reconcileOrphans(storage, new Set(), {
      olderThanHours: 24,
      now: NOW,
      dryRun: true,
    });
    expect(res.deletedKeys).toEqual(["orphan-old"]);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  test("keeps a referenced object even when old", async () => {
    const storage = fakeStorage([
      { key: "keep", size: 1, lastModified: hoursAgo(1000) },
    ]);
    const res = await reconcileOrphans(storage, new Set(["keep"]), {
      olderThanHours: 24,
      now: NOW,
    });
    expect(res.deleted).toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
