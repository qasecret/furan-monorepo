import { randomUUID } from "node:crypto";

import {
  builds,
  createDb,
  eq,
  projects,
  screenshots,
  testRuns,
  users,
  type DB,
} from "@furan/db";
import { createQueue, type DiffJob, type Queue } from "@furan/queue";
import { createStorage, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { Registry } from "prom-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { handleDiffJob } from "../src/handler.js";
import { splitLegacyJob } from "../src/legacy-split.js";
import { startDiffWorker } from "../src/runtime.js";

import { histogramSeries } from "./helpers/metrics.js";
import {
  createStepSeeder,
  square,
  type ScenarioSpec,
  type Seeded,
} from "./helpers/step-seed.js";

/**
 * Old whole-run diff jobs (no `screenshotId`), still queued when the per-step
 * worker starts, are split by the worker: one transaction bumps every step's
 * version, then one job per step is queued at it (spec 2026-10-23 §3).
 */

const skip =
  !process.env.DATABASE_URL ||
  !process.env.REDIS_URL ||
  !process.env.S3_ENDPOINT;
const desc = skip ? describe.skip : describe;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof handleDiffJob>[1];

desc("splitLegacyJob (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];
  let seed: (spec: ScenarioSpec) => Promise<Seeded>;
  let queue: Queue<DiffJob> | undefined;
  let prefix: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-split-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "legacy-split",
        role: "admin",
      })
      .returning();
    userId = u!.id;
    seed = createStepSeeder({ db, storage, userId, projectIds });
  }, 60_000);

  afterAll(async () => {
    for (const id of projectIds) {
      try {
        await db.delete(projects).where(eq(projects.id, id));
      } catch {
        /* best-effort cleanup */
      }
    }
    await redis.quit();
    await closeDb();
  });

  /** A fresh queue, on its own prefix, for each test. */
  function freshQueue(): Queue<DiffJob> {
    prefix = `furan-split-${randomUUID().slice(0, 8)}`;
    const created = createQueue("diff", { prefix });
    queue = created;
    return created;
  }

  afterEach(async () => {
    if (!queue) return;
    const q = queue;
    queue = undefined;
    const client = await q.client;
    await q.obliterate({ force: true });
    await q.close();
    client.disconnect();
  });

  async function threeSteps(): Promise<Seeded> {
    return seed({
      steps: [
        {
          name: "home",
          baseline: await square("red", 0),
          candidate: await square("blue", 0),
        },
        {
          name: "cart",
          baseline: await square("blue", 0),
          candidate: await square("blue", 0),
        },
        { name: "search", baseline: null, candidate: await square("red", 0) },
      ],
    });
  }

  async function generations(s: Seeded): Promise<Record<string, number>> {
    const rows = await db
      .select({
        id: screenshots.id,
        generation: screenshots.diffGeneration,
        queuedAt: screenshots.diffQueuedAt,
      })
      .from(screenshots)
      .where(eq(screenshots.runId, s.candidateRunId));
    for (const row of rows) expect(row.queuedAt).not.toBeNull();
    const nameOf = new Map(
      Object.entries(s.shotId).map(([name, id]) => [id, name]),
    );
    return Object.fromEntries(
      rows.map((r) => [nameOf.get(r.id)!, r.generation]),
    );
  }

  it("splits a legacy whole-run job into one job per step at a bumped version", async () => {
    const s = await threeSteps();
    const q = freshQueue();

    const added = await splitLegacyJob(
      { db },
      { runId: s.candidateRunId, projectId: s.projectId },
      q,
    );

    expect(added).toBe(3);
    expect(await generations(s)).toEqual({ home: 1, cart: 1, search: 1 });
    for (const id of Object.values(s.shotId)) {
      const job = await q.getJob(`${id}-g1`);
      expect(job?.name).toBe("diff");
      expect(job?.data).toEqual({
        runId: s.candidateRunId,
        projectId: s.projectId,
        screenshotId: id,
        generation: 1,
        parentPrBaseBranch: null,
      });
    }
    expect((await q.getJobCounts("waiting")).waiting).toBe(3);

    // The whole-run job itself diffs nothing (each step job reports its own
    // checkpoint), splits again at the next version, and carries the PR base.
    const outcome = await handleDiffJob(
      {
        runId: s.candidateRunId,
        projectId: s.projectId,
        parentPrBaseBranch: "develop",
      },
      mockLogger,
      { db, storage, redis, queue: q },
    );

    expect(outcome).toEqual({ checkpoints: 0 });
    expect(await generations(s)).toEqual({ home: 2, cart: 2, search: 2 });
    for (const id of Object.values(s.shotId)) {
      expect((await q.getJob(`${id}-g2`))?.data).toMatchObject({
        screenshotId: id,
        generation: 2,
        parentPrBaseBranch: "develop",
      });
    }
    expect((await q.getJobCounts("waiting")).waiting).toBe(6);
    // Nothing was diffed.
    const verdicts = await db
      .select({ verdict: screenshots.verdict })
      .from(screenshots)
      .where(eq(screenshots.runId, s.candidateRunId));
    expect(verdicts.every((v) => v.verdict === null)).toBe(true);
  }, 60_000);

  it("a run with no steps throws as before and adds no job", async () => {
    const uniq = randomUUID();
    const [p] = await db
      .insert(projects)
      .values({ name: `dw-split-empty-${uniq}`, mainBranchName: "main" })
      .returning();
    projectIds.push(p!.id);
    const [b] = await db
      .insert(builds)
      .values({ projectId: p!.id, userId, isRunning: true })
      .returning();
    const [r] = await db
      .insert(testRuns)
      .values({
        name: "empty",
        projectId: p!.id,
        buildId: b!.id,
        branchName: "main",
        status: "running",
      })
      .returning();
    const q = freshQueue();

    await expect(
      splitLegacyJob({ db }, { runId: r!.id, projectId: p!.id }, q),
    ).rejects.toThrow(`run_has_no_screenshots:${r!.id}`);
    const counts = await q.getJobCounts("waiting", "delayed", "active");
    expect(counts).toMatchObject({ waiting: 0, delayed: 0, active: 0 });
  }, 60_000);

  it("the worker splits a whole-run job on its own queue and diffs each step once", async () => {
    const s = await threeSteps();
    const q = freshQueue();
    const registry = new Registry();
    const runtime = startDiffWorker({
      db,
      storage,
      redis,
      logger: mockLogger,
      registry,
      queuePrefix: prefix,
      concurrency: 2,
      sweeper: false,
    });
    try {
      // The whole-run job, then its three step jobs.
      let completed = 0;
      const allDone = new Promise<void>((resolve) => {
        runtime.worker.on("completed", () => {
          if (++completed === 4) resolve();
        });
      });
      await q.add("diff", {
        runId: s.candidateRunId,
        projectId: s.projectId,
      });
      await allDone;

      expect(await generations(s)).toEqual({ home: 1, cart: 1, search: 1 });
      const shots = await db
        .select({ id: screenshots.id, verdict: screenshots.verdict })
        .from(screenshots)
        .where(eq(screenshots.runId, s.candidateRunId));
      expect(Object.fromEntries(shots.map((r) => [r.id, r.verdict]))).toEqual({
        [s.shotId.home!]: "unresolved",
        [s.shotId.cart!]: "passed",
        [s.shotId.search!]: "new",
      });
      const [run] = await db
        .select({ status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, s.candidateRunId));
      expect(run!.status).toBe("unresolved");
      // Four jobs: the split (0 checkpoints) and one per step (1 each).
      expect(
        await histogramSeries(registry, "furan_diff_job_checkpoints"),
      ).toEqual({ count: 4, sum: 3 });
    } finally {
      await runtime.close();
    }
  }, 60_000);
});
