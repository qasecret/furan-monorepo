import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolveBaseline } from "./baseline.js";
import { createDb, type DB } from "./client.js";
import {
  baselines,
  builds,
  projects,
  testRuns,
  testVariations,
  users,
} from "./schema/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_INTEGRATION = !!DATABASE_URL;

describe.runIf(RUN_INTEGRATION)("resolveBaseline (integration)", () => {
  let db: DB;
  let close: () => Promise<void>;
  let projectId: string;
  let userId: string;
  let variationId: string;
  let runId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;

    const [u] = await db
      .insert(users)
      .values({
        email: `resolve-baseline-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "Test",
        lastName: "User",
        role: "admin",
      })
      .returning({ id: users.id });
    userId = u!.id;

    const [p] = await db
      .insert(projects)
      .values({
        name: `resolve-baseline-proj-${Date.now()}`,
        mainBranchName: "main",
      })
      .returning({ id: projects.id });
    projectId = p!.id;

    const [v] = await db
      .insert(testVariations)
      .values({ name: "v1", projectId })
      .returning({ id: testVariations.id });
    variationId = v!.id;

    const [b] = await db
      .insert(builds)
      .values({ projectId, branchName: "feature/x" })
      .returning({ id: builds.id });

    const [r] = await db
      .insert(testRuns)
      .values({
        buildId: b!.id,
        projectId,
        testVariationId: variationId,
        branchName: "feature/x",
      })
      .returning({ id: testRuns.id });
    runId = r!.id;
  });

  beforeEach(async () => {
    // Clean baselines between tests
    await db.delete(baselines);
  });

  afterAll(async () => {
    await db.delete(baselines);
    await db.delete(testRuns);
    await db.delete(builds);
    await db.delete(testVariations);
    await db.delete(projects);
    await db.delete(users);
    await close();
  });

  it("returns this_branch when a baseline exists on the request branch", async () => {
    await db.insert(baselines).values({
      baselineName: "b1",
      testVariationId: variationId,
      testRunId: runId,
      userId,
      branchName: "feature/x",
    });
    const result = await resolveBaseline(
      db,
      projectId,
      "feature/x",
      variationId,
      {
        defaultBranch: "main",
      },
    );
    expect(result?.source).toBe("this_branch");
  });

  it("falls back to parent_pr when this_branch has none but parent does", async () => {
    await db.insert(baselines).values({
      baselineName: "b2",
      testVariationId: variationId,
      testRunId: runId,
      userId,
      branchName: "develop",
    });
    const result = await resolveBaseline(
      db,
      projectId,
      "feature/x",
      variationId,
      {
        defaultBranch: "main",
        parentPrBaseBranch: "develop",
      },
    );
    expect(result?.source).toBe("parent_pr");
  });

  it("falls back to default_branch when neither this_branch nor parent has one", async () => {
    await db.insert(baselines).values({
      baselineName: "b3",
      testVariationId: variationId,
      testRunId: runId,
      userId,
      branchName: "main",
    });
    const result = await resolveBaseline(
      db,
      projectId,
      "feature/x",
      variationId,
      {
        defaultBranch: "main",
      },
    );
    expect(result?.source).toBe("default_branch");
  });

  it("returns null when no baselines exist anywhere", async () => {
    const result = await resolveBaseline(
      db,
      projectId,
      "feature/x",
      variationId,
      {
        defaultBranch: "main",
      },
    );
    expect(result).toBeNull();
  });

  it("honors depthCap=0 — parent_pr path skipped", async () => {
    await db.insert(baselines).values({
      baselineName: "b4",
      testVariationId: variationId,
      testRunId: runId,
      userId,
      branchName: "develop",
    });
    const result = await resolveBaseline(
      db,
      projectId,
      "feature/x",
      variationId,
      {
        defaultBranch: "main",
        parentPrBaseBranch: "develop",
        depthCap: 0,
      },
    );
    expect(result).toBeNull();
  });
});
