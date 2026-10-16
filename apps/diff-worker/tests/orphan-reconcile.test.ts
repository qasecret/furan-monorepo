import { randomUUID } from "node:crypto";

import {
  builds,
  createDb,
  eq,
  projects,
  screenshots,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";
import type { Storage, StorageObject } from "@furan/storage";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  gatherReferencedKeys,
  reconcileOrphans,
} from "../src/orphan-reconcile.js";

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

const skip = !process.env.DATABASE_URL;
const dbDescribe = skip ? describe.skip : describe;

dbDescribe("gatherReferencedKeys (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let projectId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    const [p] = await db
      .insert(projects)
      .values({ name: `dw-orphan-${randomUUID()}`, mainBranchName: "main" })
      .returning();
    projectId = p!.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await db.delete(projects).where(eq(projects.id, projectId));
    } catch {
      /* best-effort cleanup */
    }
    await closeDb();
  });

  /**
   * A run whose one step has a diff image of its own, different from the run's
   * `diff_name` (the run's worst step is another one). Keys no other row can
   * hold, so every assertion is exact.
   */
  async function seedStepWithOwnDiff() {
    const tag = randomUUID();
    const keys = {
      image: `${tag}-image`,
      stepDiff: `${tag}-step-diff`,
      runDiff: `${tag}-run-diff`,
    };
    const [b] = await db.insert(builds).values({ projectId }).returning();
    const [run] = await db
      .insert(testRuns)
      .values({
        buildId: b!.id,
        projectId,
        name: "run",
        diffName: keys.runDiff,
      })
      .returning();
    const [v] = await db
      .insert(testVariations)
      .values({
        name: tag,
        projectId,
        branchName: "main",
        browser: "chromium",
        viewport: "400x400",
      })
      .returning();
    await db.insert(screenshots).values({
      runId: run!.id,
      projectId,
      testVariationId: v!.id,
      name: tag,
      imageKey: keys.image,
      viewport: "400x400",
      browser: "chromium",
      diffImageKey: keys.stepDiff,
    });
    return { runId: run!.id, keys };
  }

  test("references per-step diff image keys", async () => {
    const { keys } = await seedStepWithOwnDiff();

    const referenced = await gatherReferencedKeys(db);

    expect(referenced.has(keys.stepDiff)).toBe(true);
    // The run-level keys stay referenced.
    expect(referenced.has(keys.runDiff)).toBe(true);
    expect(referenced.has(keys.image)).toBe(true);
  });

  test("stops referencing a step's diff image once its row is gone", async () => {
    const { runId, keys } = await seedStepWithOwnDiff();
    // Deleting the run cascades to its steps (retention does the same).
    await db.delete(testRuns).where(eq(testRuns.id, runId));

    const referenced = await gatherReferencedKeys(db);

    expect(referenced.has(keys.stepDiff)).toBe(false);
    expect(referenced.has(keys.runDiff)).toBe(false);
  });
});
