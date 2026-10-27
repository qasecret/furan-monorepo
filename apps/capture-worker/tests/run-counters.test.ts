import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  builds,
  computeRunCounters,
  createDb,
  eq,
  loadRollupInputs,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
  type RunCounters,
} from "@furan/db";
import type { CaptureJob } from "@furan/queue";
import { createStorage, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleCaptureJob } from "../src/handler.js";
import { closeAllBrowsers } from "../src/playwright.js";

/**
 * The capture worker's writes of a run's inputs (spec 2026-10-27 speed-at-scale
 * server reads §3.2): a final failure aborts the run, a capture with nothing
 * to capture empties it, and a capture adds an undiffed step. Each recomputes
 * the run's stored pending counters in its transaction, so they stay equal to
 * what their definition gives for the run as it stands.
 *
 * Each run starts reviewable, with a pending step and its counters right, so
 * a write that forgot to recompute leaves a stale positive count behind.
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
} as unknown as Parameters<typeof handleCaptureJob>[1];

// Blocked by the SSRF guard before any browser starts.
const BLOCKED_URL = "http://169.254.169.254/";

desc("handleCaptureJob keeps the run counters right (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
    const [u] = await db
      .insert(users)
      .values({
        email: `cw-counters-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "cw",
        lastName: "counters",
        role: "admin",
      })
      .returning();
    userId = u!.id;
  }, 60_000);

  afterAll(async () => {
    for (const id of projectIds) {
      try {
        await db.delete(projects).where(eq(projects.id, id));
      } catch {
        /* best-effort cleanup */
      }
    }
    if (userId) await db.delete(users).where(eq(users.id, userId));
    await closeAllBrowsers();
    redis.disconnect();
    await closeDb();
  });

  /**
   * A capture job for `url` on a run that is already reviewable: one diffed,
   * unresolved step, and the counters a writer would have left (1 pending).
   */
  async function seedJob(
    url: string,
    viewports?: CaptureJob["viewports"],
  ): Promise<CaptureJob> {
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const [p] = await db
      .insert(projects)
      .values({ name: `cw-counters-${uniq}`, mainBranchName: "main" })
      .returning();
    projectIds.push(p!.id);
    const [b] = await db
      .insert(builds)
      .values({ projectId: p!.id, userId, isRunning: true })
      .returning();
    const [v] = await db
      .insert(testVariations)
      .values({
        name: "v",
        projectId: p!.id,
        branchName: "main",
        browser: "chromium",
        viewport: "1280x720",
      })
      .returning();
    const [r] = await db
      .insert(testRuns)
      .values({
        name: "r",
        projectId: p!.id,
        buildId: b!.id,
        branchName: "main",
        status: "unresolved",
        pendingSteps: 1,
      })
      .returning();
    await db.insert(screenshots).values({
      runId: r!.id,
      projectId: p!.id,
      testVariationId: v!.id,
      name: "earlier",
      viewport: "1280x720",
      browser: "chromium",
      imageKey: `img-${uniq}`,
      verdict: "unresolved",
      verdictAt: new Date(),
    });
    await expectCounters(r!.id, { pendingSteps: 1, failedSteps: 0 });
    return {
      runId: r!.id,
      projectId: p!.id,
      buildId: b!.id,
      testVariationId: v!.id,
      url,
      ...(viewports !== undefined
        ? { viewports }
        : { viewport: { width: 800, height: 600 } }),
      browser: "chromium",
    };
  }

  async function runStatus(runId: string): Promise<string> {
    const [row] = await db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!.status;
  }

  /** Stored = computed for the run as it stands, and that is `expected`. */
  async function expectCounters(runId: string, expected: RunCounters) {
    const input = (await loadRollupInputs(db, [runId])).get(runId)!;
    const computed = computeRunCounters(input, input.lifecycle);
    const [row] = await db
      .select({
        pendingSteps: testRuns.pendingSteps,
        failedSteps: testRuns.failedSteps,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    expect(row).toEqual(computed);
    expect(computed).toEqual(expected);
  }

  it("the final failed attempt aborts the run: the counters go to 0", async () => {
    const job = await seedJob(BLOCKED_URL);
    await expect(
      handleCaptureJob(
        job,
        mockLogger,
        { db, storage, redis },
        { finalAttempt: true },
      ),
    ).rejects.toThrow(/capture URL blocked/);
    expect(await runStatus(job.runId)).toBe("aborted");
    await expectCounters(job.runId, { pendingSteps: 0, failedSteps: 0 });
  }, 60_000);

  it("a capture with no viewport empties the run: the counters go to 0", async () => {
    const job = await seedJob("http://127.0.0.1:1/unused", []);
    await handleCaptureJob(job, mockLogger, { db, storage, redis });
    expect(await runStatus(job.runId)).toBe("empty");
    await expectCounters(job.runId, { pendingSteps: 0, failedSteps: 0 });
  }, 60_000);

  it("a capture adds an undiffed step: the run is running, the counters 0", async () => {
    let page: Server | undefined;
    try {
      page = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<!DOCTYPE html><html><body><p>counters ${Date.now()}</p></body></html>`,
        );
      });
      await new Promise<void>((r) => page!.listen(0, "127.0.0.1", () => r()));
      const port = (page.address() as AddressInfo).port;
      const job = await seedJob(`http://127.0.0.1:${port}/`);

      await handleCaptureJob(job, mockLogger, { db, storage, redis });

      const steps = await db
        .select({ verdict: screenshots.verdict })
        .from(screenshots)
        .where(eq(screenshots.runId, job.runId));
      expect(steps.map((s) => s.verdict).sort()).toEqual([null, "unresolved"]);
      expect(await runStatus(job.runId)).toBe("running");
      await expectCounters(job.runId, { pendingSteps: 0, failedSteps: 0 });
    } finally {
      if (page) await new Promise<void>((r) => page!.close(() => r()));
    }
  }, 60_000);
});
