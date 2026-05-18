import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  builds,
  createDb,
  eq,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "./index.js";

const skip = !process.env.DATABASE_URL;
const desc = skip ? describe.skip : describe;

desc("screenshots image_key uniqueness (ADR-033)", () => {
  let db: DB;
  let close: () => Promise<void>;
  let projectId: string;
  let buildId: string;
  let variationId: string;
  let userId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;
  });
  afterAll(async () => {
    await close();
  });

  beforeEach(async () => {
    const uniq = Date.now() + Math.random();
    const [u] = await db
      .insert(users)
      .values({
        email: `db-sckey-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "db",
        lastName: "sckey",
        role: "admin",
      })
      .returning();
    userId = u!.id;
    const [p] = await db
      .insert(projects)
      .values({ name: `db-sckey-${uniq}` })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, userId, isRunning: false })
      .returning();
    buildId = b!.id;
    const [v] = await db
      .insert(testVariations)
      .values({ name: "home", projectId })
      .returning();
    variationId = v!.id;
  });

  async function makeRun(): Promise<string> {
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        testVariationId: variationId,
        status: "new",
        branchName: "main",
        name: "home",
      })
      .returning();
    return r!.id;
  }

  it("allows two screenshots rows with the same image_key across different runs", async () => {
    const runA = await makeRun();
    const runB = await makeRun();
    const sharedImageKey = "a".repeat(64);

    await db.insert(screenshots).values({
      runId: runA,
      projectId,
      imageKey: sharedImageKey,
      viewport: "1280x720",
      browser: "chromium",
    });
    await db.insert(screenshots).values({
      runId: runB,
      projectId,
      imageKey: sharedImageKey,
      viewport: "1280x720",
      browser: "chromium",
    });

    const rows = await db
      .select()
      .from(screenshots)
      .where(eq(screenshots.imageKey, sharedImageKey));
    expect(rows.length).toBe(2);
  });

  it("blocks two screenshots rows with the same (run_id, viewport)", async () => {
    const runA = await makeRun();

    await db.insert(screenshots).values({
      runId: runA,
      projectId,
      imageKey: "a".repeat(64),
      viewport: "1280x720",
      browser: "chromium",
    });

    let err: unknown;
    try {
      await db.insert(screenshots).values({
        runId: runA,
        projectId,
        imageKey: "b".repeat(64),
        viewport: "1280x720",
        browser: "chromium",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    const msg = (err as Error).message ?? "";
    expect(msg).toMatch(/screenshots_run_id_viewport_unique/);
  });

  it("onConflictDoNothing on (run_id, viewport) is idempotent", async () => {
    const runA = await makeRun();

    await db
      .insert(screenshots)
      .values({
        runId: runA,
        projectId,
        imageKey: "a".repeat(64),
        viewport: "1280x720",
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.viewport],
      });
    await db
      .insert(screenshots)
      .values({
        runId: runA,
        projectId,
        imageKey: "a".repeat(64),
        viewport: "1280x720",
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.viewport],
      });

    const rows = await db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, runA));
    expect(rows.length).toBe(1);
  });
});
