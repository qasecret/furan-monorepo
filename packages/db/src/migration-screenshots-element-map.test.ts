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

desc("screenshots element_map_key column (0011)", () => {
  let db: DB;
  let close: () => Promise<void>;
  let projectId: string;
  let runId: string;
  let variationId: string;

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
        email: `db-elmap-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "db",
        lastName: "elmap",
        role: "admin",
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({ name: `db-elmap-${uniq}` })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, userId: u!.id, isRunning: false })
      .returning();
    const [v] = await db
      .insert(testVariations)
      .values({ name: "home", projectId })
      .returning();
    variationId = v!.id;
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId: b!.id,
        projectId,
        status: "new",
        branchName: "main",
        name: "home",
      })
      .returning();
    runId = r!.id;
  });

  it("inserts a screenshot row with elementMapKey populated", async () => {
    const [row] = await db
      .insert(screenshots)
      .values({
        runId,
        projectId,
        testVariationId: variationId,
        name: "home",
        imageKey: "a".repeat(64),
        viewport: "1280x720",
        browser: "selenium",
        elementMapKey: "a".repeat(64) + ".elements.json",
      })
      .returning();
    expect(row!.elementMapKey).toBe("a".repeat(64) + ".elements.json");
  });

  it("defaults elementMapKey to null when not provided", async () => {
    const [row] = await db
      .insert(screenshots)
      .values({
        runId,
        projectId,
        testVariationId: variationId,
        name: "home",
        imageKey: "b".repeat(64),
        viewport: "1280x720",
        browser: "selenium",
      })
      .returning();
    expect(row!.elementMapKey).toBeNull();
  });

  it("read-back from select picks up the column", async () => {
    await db.insert(screenshots).values({
      runId,
      projectId,
      testVariationId: variationId,
      name: "home",
      imageKey: "c".repeat(64),
      viewport: "1280x720",
      browser: "selenium",
      elementMapKey: "c".repeat(64) + ".elements.json",
    });
    const rows = await db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, runId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.elementMapKey).toBe("c".repeat(64) + ".elements.json");
  });
});
