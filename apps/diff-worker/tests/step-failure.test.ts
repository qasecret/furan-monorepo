import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  bumpStepGenerations,
  createDb,
  DIFF_ERROR_CODES,
  diffRegions,
  eq,
  projects,
  markStepDiffFailed,
  screenshots,
  sql,
  testRuns,
  users,
  type DB,
  type DiffErrorCode,
} from "@furan/db";
import {
  DEFAULT_ENGINE_CONFIG,
  DiffEngineError,
  ollamaProvider,
  runDiff,
  runL1,
} from "@furan/diff-engine";
import { createStorage, createHddStorage, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { classifyDiffError } from "../src/diff-error.js";
import { handleDiffJob, type StepJob } from "../src/handler.js";

import { pgCode } from "./helpers/pg.js";
import { stepJobsFor } from "./helpers/step-jobs.js";
import { createStepSeeder, square, type Seeded } from "./helpers/step-seed.js";

// `markStepDiffFailed` runs as itself unless a test makes it fail.
vi.mock("@furan/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@furan/db")>();
  return {
    ...actual,
    markStepDiffFailed: vi.fn(actual.markStepDiffFailed),
  };
});

/**
 * A step's permanent diff failure belongs to that step alone (spec 2026-10-23
 * §6): on the job's final attempt the step becomes `unresolved` with a reason
 * code and the run is never aborted; an earlier attempt rethrows for BullMQ to
 * retry and writes nothing.
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

/** The rejection of a promise that is expected to fail. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

describe("classifyDiffError", () => {
  let hddRoot: string;
  let png: Buffer;
  beforeAll(async () => {
    hddRoot = mkdtempSync(join(tmpdir(), "furan-diff-error-"));
    png = await square("red", 0);
  });
  afterAll(() => rmSync(hddRoot, { recursive: true, force: true }));

  /** What `@aws-sdk/client-s3` throws: a plain error with `name` and `$metadata`. */
  const s3Error = (name: string, httpStatusCode: number): Error =>
    Object.assign(new Error(`${name}: the specified key does not exist.`), {
      name,
      Code: name,
      $metadata: { httpStatusCode },
    });

  // One group per code. The errors are the real ones wherever the libraries
  // allow: the fs, sharp, pngjs, odiff and AbortSignal errors below are thrown
  // by the libraries themselves; S3's is built to its documented shape (the
  // integration test below reads a missing key from the real bucket).
  const cases: Array<[string, DiffErrorCode, () => unknown]> = [
    // object_missing
    [
      "an HDD object that is not there (fs ENOENT)",
      "object_missing",
      () => rejection(createHddStorage({ root: hddRoot }).get("no/such.png")),
    ],
    [
      "an S3 GetObject on a missing key (NoSuchKey)",
      "object_missing",
      () => s3Error("NoSuchKey", 404),
    ],
    [
      "an S3 404 without a body (NotFound)",
      "object_missing",
      () => s3Error("NotFound", 404),
    ],
    [
      "a missing object nested as a cause",
      "object_missing",
      () => new Error("diff failed", { cause: s3Error("NoSuchKey", 404) }),
    ],
    // image_unreadable
    [
      "sharp on bytes that are not an image",
      "image_unreadable",
      () => rejection(sharp(Buffer.from("not a png")).metadata()),
    ],
    [
      "sharp on an empty buffer",
      "image_unreadable",
      // sharp refuses an empty buffer as it is constructed.
      () => rejection((async () => sharp(Buffer.alloc(0)).metadata())()),
    ],
    [
      "sharp decoding a truncated PNG (libpng)",
      "image_unreadable",
      () =>
        rejection(
          sharp(png.subarray(0, png.length - 30))
            .raw()
            .toBuffer(),
        ),
    ],
    [
      "pixelmatch's decoder (pngjs) on garbage, inside the engine",
      "image_unreadable",
      () =>
        rejection(
          runDiff({
            baseline: { image: Buffer.from("garbage") },
            candidate: { image: png },
            config: {
              diffThreshold: 0.001,
              engine: "pixelmatch",
              engineConfig: DEFAULT_ENGINE_CONFIG,
            },
          }),
        ),
    ],
    [
      "odiff (libspng) on a truncated PNG, inside the engine",
      "image_unreadable",
      () =>
        rejection(
          runL1(
            png,
            png.subarray(0, png.length - 30),
            undefined,
            "odiff",
            DEFAULT_ENGINE_CONFIG,
          ),
        ),
    ],
    // engine_error
    [
      "the pixel engine rejecting its input (an unknown engine)",
      "engine_error",
      () =>
        rejection(
          runL1(png, png, undefined, "nope" as never, DEFAULT_ENGINE_CONFIG),
        ),
    ],
    [
      "an fs ENOENT inside the engine (not a storage miss)",
      "engine_error",
      async () =>
        new DiffEngineError(
          "engine",
          await rejection(readFile(join(hddRoot, "odiff", "diff.png"))),
        ),
    ],
    // vlm_error
    [
      "a vision-model provider that is unreachable",
      "vlm_error",
      async () =>
        new DiffEngineError(
          "vlm",
          await rejection(
            ollamaProvider.generate(
              {
                provider: "ollama",
                model: "m",
                prompt: "p",
                temperature: 0,
                baseUrl: "http://127.0.0.1:1",
              },
              [],
            ),
          ),
        ),
    ],
    // timeout
    [
      "a timed-out signal (TimeoutError)",
      "timeout",
      async () => {
        const signal = AbortSignal.timeout(1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return signal.reason;
      },
    ],
    [
      "an aborted request (AbortError)",
      "timeout",
      () => AbortSignal.abort().reason,
    ],
    [
      "a Postgres statement timeout (57014) under a driver wrapper",
      "timeout",
      () =>
        new Error("Failed query", {
          cause: Object.assign(
            new Error("canceling statement due to statement timeout"),
            { code: "57014" },
          ),
        }),
    ],
    // internal
    ["a plain error", "internal", () => new Error("boom")],
    ["a TypeError", "internal", () => new TypeError("x is not a function")],
    ["a thrown string", "internal", () => "boom"],
    ["nothing at all", "internal", () => undefined],
    [
      "a Postgres unique violation",
      "internal",
      () => Object.assign(new Error("duplicate key"), { code: "23505" }),
    ],
    [
      "a spawn of a missing binary (ENOENT, but not a storage miss)",
      "internal",
      () => rejection(promisify(execFile)("furan-no-such-binary-xyz")),
    ],
    [
      "a missing bucket (a 404, but not a missing object)",
      "internal",
      () => s3Error("NoSuchBucket", 404),
    ],
    [
      "a provider's own 404 (no S3 metadata)",
      "internal",
      () => Object.assign(new Error("model not found"), { status: 404 }),
    ],
  ];

  it.each(cases)("%s -> %s", async (_name, expected, make) => {
    expect(classifyDiffError(await make())).toBe(expected);
  });

  it("has a case for every code", () => {
    expect(new Set(cases.map(([, code]) => code))).toEqual(
      new Set(DIFF_ERROR_CODES),
    );
  });

  describe("when more than one class fits, the more specific wins", () => {
    it("a timeout inside the engine is a timeout", async () => {
      const timeout = AbortSignal.abort().reason;
      expect(classifyDiffError(new DiffEngineError("engine", timeout))).toBe(
        "timeout",
      );
    });

    it("an unreadable image inside the engine is the image's fault", async () => {
      const err = await rejection(
        runL1(
          png,
          Buffer.from("garbage"),
          undefined,
          "looks_same",
          DEFAULT_ENGINE_CONFIG,
        ),
      );
      expect(err).toBeInstanceOf(DiffEngineError);
      expect(classifyDiffError(err)).toBe("image_unreadable");
    });

    it("an engine error is not a storage miss even when it wraps ENOENT", async () => {
      const enoent = await rejection(readFile(join(hddRoot, "missing.png")));
      expect(classifyDiffError(enoent)).toBe("object_missing");
      expect(classifyDiffError(new DiffEngineError("engine", enoent))).toBe(
        "engine_error",
      );
    });
  });
});

desc("a step's permanent diff failure (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];
  let seed: ReturnType<typeof createStepSeeder>;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-step-failure-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "step-failure",
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

  const deps = () => ({ db, storage, redis });
  const FINAL = { finalAttempt: true };
  const RETRY = { finalAttempt: false };

  const runOf = (s: Seeded) => ({
    runId: s.candidateRunId,
    projectId: s.projectId,
  });

  /** The step job of one step, after queueing every step of the run. */
  async function jobOf(s: Seeded, name: string): Promise<StepJob> {
    const jobs = await stepJobsFor(db, runOf(s));
    return jobs.find((j) => j.screenshotId === s.shotId[name])!;
  }

  async function stepRow(id: string) {
    const [row] = await db
      .select({
        verdict: screenshots.verdict,
        verdictAt: sql<string | null>`${screenshots.verdictAt}::text`,
        diffGeneration: screenshots.diffGeneration,
        diffPercent: screenshots.diffPercent,
        pixelMismatchCount: screenshots.pixelMismatchCount,
        baselineSource: screenshots.baselineSource,
        diffImageKey: screenshots.diffImageKey,
        diffSignature: screenshots.diffSignature,
        diffFailedAt: sql<string | null>`${screenshots.diffFailedAt}::text`,
        diffError: screenshots.diffError,
      })
      .from(screenshots)
      .where(eq(screenshots.id, id));
    return row!;
  }

  async function regionCount(screenshotId: string): Promise<number> {
    const rows = await db
      .select({ id: diffRegions.id })
      .from(diffRegions)
      .where(eq(diffRegions.screenshotId, screenshotId));
    return rows.length;
  }

  async function runRow(runId: string) {
    const [row] = await db
      .select({
        status: testRuns.status,
        abortedByDiff: testRuns.abortedByDiff,
        diffPercent: testRuns.diffPercent,
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

  /** Collects the run and project channels' events published while `fn` runs. */
  async function eventsDuring(
    s: Seeded,
    fn: () => Promise<void>,
  ): Promise<Array<{ channel: string; message: Record<string, unknown> }>> {
    const events: Array<{ channel: string; message: Record<string, unknown> }> =
      [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(
      `run:${s.candidateRunId}:events`,
      `project:${s.projectId}:events:raw`,
    );
    sub.on("message", (channel, message) =>
      events.push({ channel, message: JSON.parse(message) }),
    );
    await new Promise((r) => setTimeout(r, 100));
    try {
      await fn();
    } finally {
      await new Promise((r) => setTimeout(r, 200));
      sub.disconnect();
    }
    return events;
  }

  /** The `diff_job_failed` calls a logger level received. */
  function failedLogs(level: "warn" | "error") {
    return vi
      .mocked(mockLogger[level])
      .mock.calls.filter((c) => c[1] === "diff_job_failed");
  }

  /** Forgets the logs and the marking calls so far (a test's setup diffs steps too). */
  function resetLogs(): void {
    for (const level of ["info", "warn", "error"] as const) {
      vi.mocked(mockLogger[level]).mockClear();
    }
    vi.mocked(markStepDiffFailed).mockClear();
  }

  /** Steps a, b and c, each baselined and unchanged, with a and c already diffed. */
  async function seedWithTwoDiffed(): Promise<{
    s: Seeded;
    bKey: string;
    bImage: Buffer;
  }> {
    const same = await square("red", 0);
    const s = await seed({
      steps: ["a", "b", "c"].map((name) => ({
        name,
        baseline: same,
        candidate: same,
      })),
    });
    for (const name of ["a", "c"]) {
      await handleDiffJob(await jobOf(s, name), mockLogger, deps(), FINAL);
    }
    return { s, bKey: await imageKeyOf(s.shotId.b!), bImage: same };
  }

  it("a final-attempt failure fails only that step", async () => {
    const { s, bKey } = await seedWithTwoDiffed();
    const [a0, c0] = await Promise.all([
      stepRow(s.shotId.a!),
      stepRow(s.shotId.c!),
    ]);
    expect(a0.verdict).toBe("passed");
    const runBefore = await runRow(s.candidateRunId);
    expect(runBefore.status).toBe("running");
    // Step b's candidate image is gone from storage: the real object store
    // answers its read with NoSuchKey.
    await storage.delete(bKey);
    const job = await jobOf(s, "b");
    resetLogs();

    const events = await eventsDuring(s, async () => {
      await expect(
        handleDiffJob(job, mockLogger, deps(), FINAL),
      ).rejects.toThrow();
    });

    // The step: unresolved, with a reason code (never a message), no result.
    const b = await stepRow(s.shotId.b!);
    expect(b).toMatchObject({
      verdict: "unresolved",
      diffError: "object_missing",
      diffPercent: null,
      pixelMismatchCount: null,
      baselineSource: null,
      diffImageKey: null,
      diffSignature: null,
    });
    expect(b.diffFailedAt).not.toBeNull();
    expect(b.verdictAt).not.toBeNull();
    expect(await regionCount(s.shotId.b!)).toBe(0);

    // The others are untouched by it (their versions moved only because
    // `jobOf` queued every step).
    const [a1, c1] = await Promise.all([
      stepRow(s.shotId.a!),
      stepRow(s.shotId.c!),
    ]);
    expect(a1).toEqual({ ...a0, diffGeneration: a1.diffGeneration });
    expect(c1).toEqual({ ...c0, diffGeneration: c1.diffGeneration });

    // The run is unresolved because of the failed step, and not aborted; the
    // failed step adds nothing to its totals.
    expect(await runRow(s.candidateRunId)).toEqual({
      ...runBefore,
      status: "unresolved",
      abortedByDiff: false,
    });

    // The failure is logged once, in full, with its code.
    const logged = failedLogs("error");
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({
      runId: s.candidateRunId,
      screenshotId: s.shotId.b,
      code: "object_missing",
    });
    expect((logged[0]![0] as { err: unknown }).err).toBeInstanceOf(Error);
    expect(failedLogs("warn")).toHaveLength(0);

    // The same interim events a committed step publishes, with the new status.
    const runEvents = events.filter(
      (e) => e.channel === `run:${s.candidateRunId}:events`,
    );
    expect(runEvents.map((e) => e.message.type)).toEqual([
      "diff.started",
      "diff.completed",
      "run.completed",
    ]);
    expect(runEvents[1]!.message).toMatchObject({
      type: "diff.completed",
      passed: false,
    });
    expect(runEvents[2]!.message).toMatchObject({
      type: "run.completed",
      runId: s.candidateRunId,
      status: "unresolved",
    });
    expect(
      events.find((e) => e.message.event === "testRun_updated")?.message.data,
    ).toEqual({ id: s.candidateRunId, status: "unresolved" });
  }, 60_000);

  it("a corrupt candidate image fails the step as image_unreadable", async () => {
    const { s, bKey } = await seedWithTwoDiffed();
    await storage.put(bKey, Buffer.from("not a png"), "image/png");
    resetLogs();

    await expect(
      handleDiffJob(await jobOf(s, "b"), mockLogger, deps(), FINAL),
    ).rejects.toThrow();

    expect(await stepRow(s.shotId.b!)).toMatchObject({
      verdict: "unresolved",
      diffError: "image_unreadable",
    });
    expect((await runRow(s.candidateRunId)).status).toBe("unresolved");
    expect(failedLogs("error")[0]![0]).toMatchObject({
      code: "image_unreadable",
    });
  }, 60_000);

  it("a non-final failure rethrows and writes nothing", async () => {
    const { s, bKey } = await seedWithTwoDiffed();
    await storage.delete(bKey);
    const job = await jobOf(s, "b");
    const before = await stepRow(s.shotId.b!);
    resetLogs();

    const events = await eventsDuring(s, async () => {
      await expect(
        handleDiffJob(job, mockLogger, deps(), RETRY),
      ).rejects.toThrow();
    });

    expect(await stepRow(s.shotId.b!)).toEqual(before);
    expect(before).toMatchObject({
      verdict: null,
      diffFailedAt: null,
      diffError: null,
    });
    expect(await runRow(s.candidateRunId)).toMatchObject({
      status: "running",
      abortedByDiff: false,
    });
    expect(events).toEqual([]);
    expect(vi.mocked(markStepDiffFailed)).not.toHaveBeenCalled();
    // A retry is coming: a warning, not an error.
    expect(failedLogs("warn")).toHaveLength(1);
    expect(failedLogs("error")).toHaveLength(0);
  }, 60_000);

  it("a final failure on a newer version does nothing", async () => {
    const { s, bKey } = await seedWithTwoDiffed();
    await storage.delete(bKey);
    const job = await jobOf(s, "b");
    // A newer version of the step is queued while this job is reading its
    // image: the job passes the stale check, then fails on the missing object.
    let bumped: number | undefined;
    const racing = new Proxy(storage, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "get") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (key: string) => {
          if (bumped === undefined && key === bKey) {
            const [row] = await db.transaction((tx) =>
              bumpStepGenerations(tx, s.candidateRunId, [s.shotId.b!]),
            );
            bumped = row!.generation;
          }
          return target.get(key);
        };
      },
    });
    const before = await stepRow(s.shotId.b!);
    resetLogs();

    const events = await eventsDuring(s, async () => {
      await expect(
        handleDiffJob(job, mockLogger, { db, storage: racing, redis }, FINAL),
      ).rejects.toThrow();
    });

    expect(bumped).toBe(job.generation + 1);
    // Nothing of the old job's failure is written: the step is as the newer
    // version's queueing left it.
    expect(await stepRow(s.shotId.b!)).toEqual({
      ...before,
      diffGeneration: bumped,
    });
    expect(await stepRow(s.shotId.b!)).toMatchObject({
      verdict: null,
      diffFailedAt: null,
      diffError: null,
    });
    expect(await runRow(s.candidateRunId)).toMatchObject({
      status: "running",
      abortedByDiff: false,
    });
    expect(events).toEqual([]);
    expect(vi.mocked(markStepDiffFailed)).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(mockLogger.info)
        .mock.calls.filter((c) => c[1] === "diff_step_stale"),
    ).toHaveLength(1);
  }, 60_000);

  it("a successful re-diff clears the failure", async () => {
    const { s, bKey, bImage } = await seedWithTwoDiffed();
    await storage.delete(bKey);
    await expect(
      handleDiffJob(await jobOf(s, "b"), mockLogger, deps(), FINAL),
    ).rejects.toThrow();
    expect(await stepRow(s.shotId.b!)).toMatchObject({
      verdict: "unresolved",
      diffError: "object_missing",
    });
    expect((await runRow(s.candidateRunId)).status).toBe("unresolved");

    // The cause clears and the step is queued again, at a new version.
    await storage.put(bKey, bImage, "image/png");
    await handleDiffJob(await jobOf(s, "b"), mockLogger, deps(), FINAL);

    expect(await stepRow(s.shotId.b!)).toMatchObject({
      verdict: "passed",
      diffFailedAt: null,
      diffError: null,
    });
    expect(await runRow(s.candidateRunId)).toMatchObject({
      status: "passed",
      abortedByDiff: false,
    });
  }, 60_000);

  it("when marking the step failed itself fails, it is logged and the original error is rethrown", async () => {
    const { s, bKey } = await seedWithTwoDiffed();
    await storage.delete(bKey);
    const job = await jobOf(s, "b");
    vi.mocked(markStepDiffFailed).mockRejectedValueOnce(new Error("db_down"));
    resetLogs();

    const err = await rejection(handleDiffJob(job, mockLogger, deps(), FINAL));

    // The job's own error, not the write's.
    expect(String(err)).not.toMatch(/db_down/);
    // The step keeps no verdict: the reconciler re-queues it later.
    expect(await stepRow(s.shotId.b!)).toMatchObject({
      verdict: null,
      diffFailedAt: null,
      diffError: null,
    });
    expect((await runRow(s.candidateRunId)).status).toBe("running");
    const writeFailed = vi
      .mocked(mockLogger.error)
      .mock.calls.filter((c) => c[1] === "failed_to_mark_step_failed");
    expect(writeFailed).toHaveLength(1);
    expect(String((writeFailed[0]![0] as { err: unknown }).err)).toMatch(
      /db_down/,
    );
    expect(failedLogs("error")).toHaveLength(1);
  }, 60_000);

  it("a real Postgres statement timeout is classified as a timeout", async () => {
    const err = await rejection(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = 20`);
        await tx.execute(sql`SELECT pg_sleep(1)`);
      }),
    );
    expect(pgCode(err)).toBe("57014");
    expect(classifyDiffError(err)).toBe("timeout");
  }, 30_000);

  it("a real read of a missing S3 key is classified as object_missing", async () => {
    const err = await rejection(storage.get(`no-such-key-${Date.now()}`));
    expect(classifyDiffError(err)).toBe("object_missing");
  }, 30_000);
});
