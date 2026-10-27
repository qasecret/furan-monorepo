import {
  createDb,
  diffRegions,
  eq,
  projects,
  screenshots,
  testRuns,
  users,
  type DB,
} from "@furan/db";
import { createStorage, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleDiffJob, type StepJob } from "../src/handler.js";
import { publishStepEvents } from "../src/step-events.js";

import { stepJobsFor } from "./helpers/step-jobs.js";
import {
  createStepSeeder,
  square,
  type ScenarioSpec,
  type Seeded,
} from "./helpers/step-seed.js";
import { withDiffWorker } from "./helpers/worker.js";

/**
 * The events a step job publishes (spec 2026-10-23 §8): one
 * `run.checkpoint_diffed` per step, and `run.completed` / `testRun_updated` /
 * `build_updated` only when the run's status changes. `diff.started` and
 * `diff.completed` are retired.
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

// The candidate DOM of a step whose change is wrapped by `#box` (at 0,0): the
// project's `#box` rule auto-approves it, so it wins its one region.
const BOX_DOM =
  '<!doctype html><html lang="en"><head><title>t</title></head><body><div id="box">box</div></body></html>';
const BOX_0 = { x: 0, y: 0, width: 144, height: 144 };

const SENTINEL = "test.sentinel";

type Frame = Record<string, unknown>;

/** The frames each channel carried while a block ran. */
interface Frames {
  run: Frame[];
  project: Frame[];
}

desc("step events (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];
  let seed: (spec: ScenarioSpec) => Promise<Seeded>;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-step-events-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "step-events",
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

  const red0 = () => square("red", 0);
  const blue0 = () => square("blue", 0);

  const deps = () => ({ db, storage, redis });
  const FINAL = { finalAttempt: true };

  const runOf = (s: Seeded) => ({
    runId: s.candidateRunId,
    projectId: s.projectId,
  });
  const runChannel = (s: Seeded) => `run:${s.candidateRunId}:events`;
  const projectChannel = (s: Seeded) => `project:${s.projectId}:events:raw`;

  /** Queues every step of the run; the jobs come back in capture order. */
  const jobsOf = (s: Seeded): Promise<StepJob[]> => stepJobsFor(db, runOf(s));

  /**
   * The frames published on the run's two channels while `fn` runs. Redis
   * delivers a channel's messages in publish order, and everything `fn`
   * published was acknowledged before it returned, so once a sentinel
   * published after it has arrived on each channel, nothing earlier is still
   * in flight.
   */
  async function framesDuring(
    s: Seeded,
    fn: () => Promise<void>,
  ): Promise<Frames> {
    const frames: Frames = { run: [], project: [] };
    const sub = new Redis(process.env.REDIS_URL!);
    let sentinels = 0;
    let release!: () => void;
    const settled = new Promise<void>((resolve) => (release = resolve));
    sub.on("message", (channel, message) => {
      const frame = JSON.parse(message) as Frame;
      if (frame.type === SENTINEL || frame.event === SENTINEL) {
        if (++sentinels === 2) release();
        return;
      }
      (channel === runChannel(s) ? frames.run : frames.project).push(frame);
    });
    await sub.subscribe(runChannel(s), projectChannel(s));
    try {
      await fn();
      await redis.publish(runChannel(s), JSON.stringify({ type: SENTINEL }));
      await redis.publish(
        projectChannel(s),
        JSON.stringify({ event: SENTINEL }),
      );
      await settled;
    } finally {
      sub.disconnect();
    }
    return frames;
  }

  async function runRow(runId: string) {
    const [row] = await db
      .select({
        status: testRuns.status,
        diffPercent: testRuns.diffPercent,
        resolutionSource: testRuns.resolutionSource,
        buildId: testRuns.buildId,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!;
  }

  async function imageKeyOf(id: string): Promise<string> {
    const [row] = await db
      .select({ imageKey: screenshots.imageKey })
      .from(screenshots)
      .where(eq(screenshots.id, id));
    return row!.imageKey;
  }

  /** The project-channel frame the worker publishes for `event`. */
  const projectFrame = (event: string, data: unknown) => ({
    event,
    data,
    ts: expect.any(Number),
  });

  /** A step whose change the `#box` rule auto-approves, and one that is unchanged. */
  async function ruleResolvedAndUnchanged(): Promise<Seeded> {
    return seed({
      ruleSelectors: ["#box"],
      steps: [
        {
          name: "home",
          baseline: await red0(),
          candidate: await blue0(),
          candidateDom: BOX_DOM,
          candidateMap: { "#box": BOX_0 },
        },
        { name: "cart", baseline: await red0(), candidate: await red0() },
      ],
    });
  }

  it("a step commit that doesn't change the run's status publishes only run.checkpoint_diffed", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await blue0() },
        { name: "cart", baseline: await red0(), candidate: await red0() },
      ],
    });
    const [home] = await jobsOf(s);

    const frames = await framesDuring(s, async () => {
      await handleDiffJob(home!, mockLogger, deps(), FINAL);
    });

    // The run stays `running`: `cart` has no verdict yet.
    expect((await runRow(s.candidateRunId)).status).toBe("running");
    expect(frames.run).toEqual([
      {
        type: "run.checkpoint_diffed",
        runId: s.candidateRunId,
        screenshotId: s.shotId.home,
        verdict: "unresolved",
        failed: false,
      },
    ]);
    expect(frames.project).toEqual([
      projectFrame("run.checkpoint_diffed", {
        runId: s.candidateRunId,
        screenshotId: s.shotId.home,
      }),
    ]);
  }, 60_000);

  it("the commit that changes the status also publishes run.completed, testRun_updated and build_updated, once", async () => {
    const s = await ruleResolvedAndUnchanged();
    const [home, cart] = await jobsOf(s);

    const frames = await framesDuring(s, async () => {
      await handleDiffJob(home!, mockLogger, deps(), FINAL);
      await handleDiffJob(cart!, mockLogger, deps(), FINAL);
    });

    const run = await runRow(s.candidateRunId);
    expect(run.status).toBe("passed");
    expect(run.diffPercent).toBeGreaterThan(0);
    expect(run.resolutionSource).toBe("rule");
    const checkpoint = (name: string, verdict: string) => ({
      type: "run.checkpoint_diffed",
      runId: s.candidateRunId,
      screenshotId: s.shotId[name],
      verdict,
      failed: false,
    });
    expect(frames.run).toEqual([
      checkpoint("home", "passed"),
      checkpoint("cart", "passed"),
      // The totals come from the database: the run's diff %, its one region,
      // and the one auto-approve application the `#box` rule won.
      {
        type: "run.completed",
        runId: s.candidateRunId,
        projectId: s.projectId,
        status: "passed",
        diffPercent: run.diffPercent,
        branchName: "main",
        numChanges: 1,
        resolutionSource: "rule",
        rulesSummary: { auto_approve: 1, flag: 0 },
      },
    ]);
    const perStep = (name: string) =>
      projectFrame("run.checkpoint_diffed", {
        runId: s.candidateRunId,
        screenshotId: s.shotId[name],
      });
    expect(frames.project).toEqual([
      perStep("home"),
      perStep("cart"),
      projectFrame("testRun_updated", {
        id: s.candidateRunId,
        status: "passed",
      }),
      projectFrame("build_updated", { id: s.buildId }),
    ]);
  }, 60_000);

  it("a 5-step run publishes testRun_updated at most status-changes + 2 times", async () => {
    const same = await red0();
    const s = await seed({
      steps: [
        ...["a", "b", "c", "d"].map((name) => ({
          name,
          baseline: same,
          candidate: same,
        })),
        { name: "e", baseline: same, candidate: await blue0() },
      ],
    });
    const jobs = await jobsOf(s);
    expect(jobs).toHaveLength(5);

    const frames = await framesDuring(s, async () => {
      await withDiffWorker(
        { db, storage, redis, logger: mockLogger },
        async ({ run }) => {
          for (const job of jobs) await run(job);
        },
      );
    });

    // Status changes, read from the `run.completed` frames: each one that
    // moves the status on from where the run was (`running`).
    let status = "running";
    let statusChanges = 0;
    for (const f of frames.run.filter((f) => f.type === "run.completed")) {
      if (f.status !== status) statusChanges++;
      status = f.status as string;
    }
    const testRunUpdated = frames.project.filter(
      (f) => f.event === "testRun_updated",
    );
    expect(status).toBe("unresolved");
    expect(statusChanges).toBeGreaterThanOrEqual(1);
    expect(testRunUpdated.length).toBeLessThanOrEqual(statusChanges + 2);
    // One per step all the same, on both channels.
    expect(
      frames.run.filter((f) => f.type === "run.checkpoint_diffed"),
    ).toHaveLength(5);
    expect(
      frames.project.filter((f) => f.event === "run.checkpoint_diffed"),
    ).toHaveLength(5);
  }, 120_000);

  it("no diff.started or diff.completed is published", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await blue0() },
        { name: "cart", baseline: await red0(), candidate: await red0() },
      ],
    });
    const [home, cart] = await jobsOf(s);
    // `cart` fails for good; `home` commits.
    await storage.delete(await imageKeyOf(s.shotId.cart!));

    const frames = await framesDuring(s, async () => {
      await handleDiffJob(home!, mockLogger, deps(), FINAL);
      await expect(
        handleDiffJob(cart!, mockLogger, deps(), FINAL),
      ).rejects.toThrow();
    });

    const names = [
      ...frames.run.map((f) => f.type),
      ...frames.project.map((f) => f.event),
    ];
    expect(names).toContain("run.checkpoint_diffed");
    expect(names).not.toContain("diff.started");
    expect(names).not.toContain("diff.completed");
  }, 60_000);

  it("a final failure publishes run.checkpoint_diffed with failed: true", async () => {
    const s = await seed({
      steps: [
        { name: "a", baseline: await red0(), candidate: await red0() },
        { name: "b", baseline: await red0(), candidate: await red0() },
      ],
    });
    const [a, b] = await jobsOf(s);
    await handleDiffJob(a!, mockLogger, deps(), FINAL);
    // Step b's candidate image is gone from storage.
    await storage.delete(await imageKeyOf(s.shotId.b!));

    const frames = await framesDuring(s, async () => {
      await expect(
        handleDiffJob(b!, mockLogger, deps(), FINAL),
      ).rejects.toThrow();
    });

    // The failed step was the last one without a verdict: the run moves from
    // `running` to `unresolved`, so the status events follow.
    const run = await runRow(s.candidateRunId);
    expect(run.status).toBe("unresolved");
    expect(frames.run).toEqual([
      {
        type: "run.checkpoint_diffed",
        runId: s.candidateRunId,
        screenshotId: s.shotId.b,
        verdict: "unresolved",
        failed: true,
      },
      {
        type: "run.completed",
        runId: s.candidateRunId,
        projectId: s.projectId,
        status: "unresolved",
        // The passed step `a` compared at 0; the failed one adds nothing.
        diffPercent: run.diffPercent,
        branchName: "main",
        numChanges: 0,
        resolutionSource: null,
        rulesSummary: null,
      },
    ]);
    expect(frames.project).toEqual([
      projectFrame("run.checkpoint_diffed", {
        runId: s.candidateRunId,
        screenshotId: s.shotId.b,
      }),
      projectFrame("testRun_updated", {
        id: s.candidateRunId,
        status: "unresolved",
      }),
      projectFrame("build_updated", { id: s.buildId }),
    ]);
  }, 60_000);

  it("a final failure that leaves the run running publishes only run.checkpoint_diffed", async () => {
    const s = await seed({
      steps: [
        { name: "a", baseline: await red0(), candidate: await red0() },
        { name: "b", baseline: await red0(), candidate: await red0() },
      ],
    });
    const [a] = await jobsOf(s);
    await storage.delete(await imageKeyOf(s.shotId.a!));

    const frames = await framesDuring(s, async () => {
      await expect(
        handleDiffJob(a!, mockLogger, deps(), FINAL),
      ).rejects.toThrow();
    });

    // `b` still has no verdict.
    expect((await runRow(s.candidateRunId)).status).toBe("running");
    expect(frames.run).toEqual([
      {
        type: "run.checkpoint_diffed",
        runId: s.candidateRunId,
        screenshotId: s.shotId.a,
        verdict: "unresolved",
        failed: true,
      },
    ]);
    expect(frames.project).toEqual([
      projectFrame("run.checkpoint_diffed", {
        runId: s.candidateRunId,
        screenshotId: s.shotId.a,
      }),
    ]);
  }, 60_000);

  it("the status announced is the run's as stored when the events are read, not this commit's", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await red0() },
      ],
    });
    // This step's commit moved the run from running to passed. Before its
    // events are read, a later commit of another step moved the run on to
    // unresolved (and published that): this job must not re-announce passed.
    await db
      .update(testRuns)
      .set({ status: "unresolved" })
      .where(eq(testRuns.id, s.candidateRunId));

    const frames = await framesDuring(s, async () => {
      await publishStepEvents(redis, {
        runId: s.candidateRunId,
        projectId: s.projectId,
        screenshotId: s.shotId.home!,
        verdict: "passed",
        failed: false,
        rollup: { before: "running", after: "passed" },
        db,
        logger: mockLogger,
      });
    });

    expect(frames.run.find((f) => f.type === "run.completed")).toMatchObject({
      status: "unresolved",
    });
    expect(frames.project.filter((f) => f.event === "testRun_updated")).toEqual(
      [
        projectFrame("testRun_updated", {
          id: s.candidateRunId,
          status: "unresolved",
        }),
      ],
    );
  }, 60_000);

  it("run.completed omits diffPercent when the run has no stored diff %", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await red0() },
      ],
    });
    const [home] = await jobsOf(s);
    // The run's only step fails for good: it adds nothing to the totals, so
    // the run's `diff_percent` stays NULL while its status moves.
    await storage.delete(await imageKeyOf(s.shotId.home!));

    const frames = await framesDuring(s, async () => {
      await expect(
        handleDiffJob(home!, mockLogger, deps(), FINAL),
      ).rejects.toThrow();
    });

    expect((await runRow(s.candidateRunId)).diffPercent).toBeNull();
    const completed = frames.run.find((f) => f.type === "run.completed");
    expect(completed).toMatchObject({ status: "unresolved" });
    expect(completed).not.toHaveProperty("diffPercent");
  }, 60_000);

  it("run.completed's numChanges counts engine regions, not dynamic-text audit rows", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await red0() },
      ],
    });
    const home = s.shotId.home!;
    const region = (source: string) => ({
      runId: s.candidateRunId,
      projectId: s.projectId,
      screenshotId: home,
      severity: "moderate",
      category: "visual",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      description: "region",
      source,
      viewport: "400x400",
    });
    // Two engine regions and a layout-suppressed one (a region the run had)
    // count; the OCR audit rows of dynamic text (matched or not) do not.
    await db
      .insert(diffRegions)
      .values([
        region("l1_pixel"),
        region("l1_pixel"),
        region("layout_suppressed"),
        region("dynamic_text"),
        region("dynamic_text"),
      ]);

    const frames = await framesDuring(s, async () => {
      await publishStepEvents(redis, {
        runId: s.candidateRunId,
        projectId: s.projectId,
        screenshotId: home,
        verdict: "passed",
        failed: false,
        rollup: { before: "running", after: "unresolved" },
        db,
        logger: mockLogger,
      });
    });

    const completed = frames.run.find((f) => f.type === "run.completed");
    expect(completed).toMatchObject({ numChanges: 3 });
  }, 60_000);

  it("an old whole-run job is split and publishes nothing itself", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await red0() },
      ],
    });
    const queue = { addBulk: vi.fn().mockResolvedValue([]) };

    const frames = await framesDuring(s, async () => {
      await handleDiffJob(runOf(s), mockLogger, { ...deps(), queue }, FINAL);
    });

    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(frames).toEqual({ run: [], project: [] });
  }, 60_000);

  describe("best-effort", () => {
    /** A single-step run, as the args `publishStepEvents` takes for its commit. */
    async function publishArgs(
      overrides: Partial<Parameters<typeof publishStepEvents>[1]> = {},
    ) {
      const s = await seed({
        steps: [
          { name: "home", baseline: await red0(), candidate: await red0() },
        ],
      });
      return {
        s,
        args: {
          runId: s.candidateRunId,
          projectId: s.projectId,
          screenshotId: s.shotId.home!,
          verdict: "passed",
          failed: false,
          rollup: { before: "running", after: "passed" },
          db,
          logger: mockLogger,
          ...overrides,
        } as Parameters<typeof publishStepEvents>[1],
      };
    }

    const publishFailures = () =>
      vi
        .mocked(mockLogger.warn)
        .mock.calls.filter((c) => c[1] === "diff_step_event_publish_failed");

    it("a failing Redis publish is logged and doesn't reject", async () => {
      const { args } = await publishArgs();
      const down = {
        publish: vi.fn().mockRejectedValue(new Error("redis_down")),
      } as unknown as Redis;
      vi.mocked(mockLogger.warn).mockClear();

      await expect(publishStepEvents(down, args)).resolves.toBeUndefined();

      // Each of the five events was tried and each failure logged.
      expect(vi.mocked(down.publish)).toHaveBeenCalledTimes(5);
      expect(publishFailures()).toHaveLength(5);
      expect(publishFailures()[0]![0]).toMatchObject({
        runId: args.runId,
        err: expect.objectContaining({ message: "redis_down" }),
      });
    }, 60_000);

    it("a failing per-step publish doesn't stop run.completed", async () => {
      const { s, args } = await publishArgs();
      const flaky = new Proxy(redis, {
        get(target, prop) {
          if (prop === "publish") {
            return async (channel: string, message: string) => {
              if (message.includes("run.checkpoint_diffed")) {
                throw new Error("redis_blip");
              }
              return target.publish(channel, message);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      vi.mocked(mockLogger.warn).mockClear();

      const frames = await framesDuring(s, async () => {
        await publishStepEvents(flaky, args);
      });

      expect(frames.run.map((f) => f.type)).toEqual(["run.completed"]);
      expect(frames.project.map((f) => f.event)).toEqual([
        "testRun_updated",
        "build_updated",
      ]);
      expect(publishFailures()).toHaveLength(2);
    }, 60_000);

    it("a failing read of the run is logged and doesn't reject", async () => {
      const { s, args } = await publishArgs();
      const brokenDb = {
        transaction: vi.fn().mockRejectedValue(new Error("db_down")),
      } as unknown as DB;
      vi.mocked(mockLogger.warn).mockClear();

      const frames = await framesDuring(s, async () => {
        await expect(
          publishStepEvents(redis, { ...args, db: brokenDb }),
        ).resolves.toBeUndefined();
      });

      // The per-step events don't need the database; the status events do.
      expect(frames.run.map((f) => f.type)).toEqual(["run.checkpoint_diffed"]);
      expect(frames.project.map((f) => f.event)).toEqual([
        "run.checkpoint_diffed",
      ]);
      expect(
        vi
          .mocked(mockLogger.warn)
          .mock.calls.filter((c) => c[1] === "diff_step_event_read_failed"),
      ).toHaveLength(1);
    }, 60_000);

    it("a Redis outage after the commit doesn't fail the job", async () => {
      const s = await seed({
        steps: [
          { name: "home", baseline: await red0(), candidate: await blue0() },
        ],
      });
      const [job] = await jobsOf(s);
      const down = new Proxy(redis, {
        get(target, prop) {
          if (prop === "publish") {
            return async () => {
              throw new Error("redis_down_after_commit");
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      // The job completes: the events are best-effort, the commit has landed.
      await expect(
        handleDiffJob(job!, mockLogger, { db, storage, redis: down }, FINAL),
      ).resolves.toEqual({ checkpoints: 1 });

      expect((await runRow(s.candidateRunId)).status).toBe("unresolved");
    }, 60_000);
  });
});
