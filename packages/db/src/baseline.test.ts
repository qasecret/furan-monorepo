import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { recordBaseline, resolveBaseline } from "./baseline.js";
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
  // ADR-054: the same checkpoint on each branch is a DISTINCT variation row.
  // The candidate lives on feature/x; develop + main hold the sibling variations
  // whose baselines the parent_pr / default_branch tiers must resolve.
  let variationId: string; // feature/x — the candidate
  let developVariationId: string; // develop — parent sibling
  let mainVariationId: string; // main — default sibling
  let runId: string; // feature/x
  let developRunId: string;
  let mainRunId: string;

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

    // One variation + run per branch, all sharing the branch-agnostic identity
    // (name "v1", null viewport/browser/os/device) — exactly what
    // resolveOrCreateVariation produces per branch in production.
    const mkVariationAndRun = async (
      branchName: string,
    ): Promise<{ variationId: string; runId: string }> => {
      const [v] = await db
        .insert(testVariations)
        .values({ name: "v1", projectId, branchName })
        .returning({ id: testVariations.id });
      const [b] = await db
        .insert(builds)
        .values({ projectId, branchName })
        .returning({ id: builds.id });
      const [r] = await db
        .insert(testRuns)
        .values({ buildId: b!.id, projectId, name: "v1", branchName })
        .returning({ id: testRuns.id });
      return { variationId: v!.id, runId: r!.id };
    };

    const feature = await mkVariationAndRun("feature/x");
    variationId = feature.variationId;
    runId = feature.runId;
    const develop = await mkVariationAndRun("develop");
    developVariationId = develop.variationId;
    developRunId = develop.runId;
    const main = await mkVariationAndRun("main");
    mainVariationId = main.variationId;
    mainRunId = main.runId;
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
    // this_branch resolves under the candidate's own variation.
    expect(result?.baselineVariationId).toBe(variationId);
  });

  it("falls back to parent_pr when this_branch has none but parent does", async () => {
    // The parent baseline lives under the DEVELOP-branch sibling variation
    // (ADR-054), not the candidate's feature/x variation.
    await db.insert(baselines).values({
      baselineName: "b2",
      testVariationId: developVariationId,
      testRunId: developRunId,
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
    expect(result?.baselineId).toBeTruthy();
    // The resolved baseline lives under the SIBLING (develop) variation, not
    // the candidate's — callers fetch the baseline screenshot by this id.
    expect(result?.baselineVariationId).toBe(developVariationId);
  });

  it("falls back to default_branch when neither this_branch nor parent has one", async () => {
    // The default baseline lives under the MAIN-branch sibling variation.
    await db.insert(baselines).values({
      baselineName: "b3",
      testVariationId: mainVariationId,
      testRunId: mainRunId,
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
    expect(result?.baselineId).toBeTruthy();
    expect(result?.baselineVariationId).toBe(mainVariationId);
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

  it("recordBaseline upserts on (variation, run) — a retry does not duplicate", async () => {
    // Two records for the same (variation, run) — a diff-worker retry, or an
    // approve after an auto-seed — must leave exactly one baseline row.
    await recordBaseline(db, {
      testVariationId: variationId,
      testRunId: runId,
      imageKey: "key-1",
      branchName: "feature/x",
    });
    await recordBaseline(db, {
      testVariationId: variationId,
      testRunId: runId,
      imageKey: "key-1",
      userId,
      branchName: "feature/x",
    });
    const rows = await db
      .select({ id: baselines.id, userId: baselines.userId })
      .from(baselines)
      .where(eq(baselines.testRunId, runId));
    expect(rows).toHaveLength(1);
    // The second (approve) call's userId won via DO UPDATE.
    expect(rows[0]!.userId).toBe(userId);
  });

  it("honors depthCap=0 — parent_pr path skipped", async () => {
    await db.insert(baselines).values({
      baselineName: "b4",
      testVariationId: developVariationId,
      testRunId: developRunId,
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
