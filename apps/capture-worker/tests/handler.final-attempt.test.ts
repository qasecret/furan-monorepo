import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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
} from "@furan/db";
import type { CaptureJob } from "@furan/queue";
import { createStorage, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleCaptureJob } from "../src/handler.js";
import { closeAllBrowsers } from "../src/playwright.js";

/**
 * Ruling R10: a failed capture attempt writes `aborted` only when it is the
 * job's FINAL attempt. `recomputeRunStatus` keeps `aborted` (a lifecycle
 * state), so writing it on an attempt BullMQ is about to retry would stick
 * even after the retry captures successfully.
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

// The cloud-metadata address is blocked by the SSRF guard before any browser
// starts, so a failing attempt costs nothing.
const BLOCKED_URL = "http://169.254.169.254/";

desc(
  "handleCaptureJob — aborted only on the final attempt (integration)",
  () => {
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
          email: `cw-final-${Date.now()}@x.test`,
          hashedPassword: "x",
          firstName: "cw",
          lastName: "final-attempt",
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
      await closeAllBrowsers();
      redis.disconnect();
      await closeDb();
    });

    /** A `running` run with its variation, as a capture job for `url`. */
    async function seedJob(url: string): Promise<CaptureJob> {
      const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const [p] = await db
        .insert(projects)
        .values({ name: `cw-final-${uniq}`, mainBranchName: "main" })
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
          status: "running",
        })
        .returning();
      return {
        runId: r!.id,
        projectId: p!.id,
        buildId: b!.id,
        testVariationId: v!.id,
        url,
        viewport: { width: 1280, height: 720 },
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

    /** Collects the run channel's events published while `fn` runs. */
    async function eventsDuring(
      runId: string,
      fn: () => Promise<void>,
    ): Promise<Array<{ type: string; status?: string }>> {
      const events: Array<{ type: string; status?: string }> = [];
      const sub = new Redis(process.env.REDIS_URL!);
      await sub.subscribe(`run:${runId}:events`);
      sub.on("message", (_ch, msg) => events.push(JSON.parse(msg)));
      await new Promise((r) => setTimeout(r, 100));
      try {
        await fn();
      } finally {
        await new Promise((r) => setTimeout(r, 200));
        sub.disconnect();
      }
      return events;
    }

    it("a non-final failed attempt leaves the status alone, publishes no run.completed and rethrows", async () => {
      const job = await seedJob(BLOCKED_URL);

      const events = await eventsDuring(job.runId, async () => {
        await expect(
          handleCaptureJob(
            job,
            mockLogger,
            { db, storage, redis },
            { finalAttempt: false },
          ),
        ).rejects.toThrow(/capture URL blocked/);
      });

      expect(await runStatus(job.runId)).toBe("running");
      expect(events.find((e) => e.type === "run.completed")).toBeUndefined();
    }, 60_000);

    it("the final failed attempt writes aborted and publishes it", async () => {
      const job = await seedJob(BLOCKED_URL);

      const events = await eventsDuring(job.runId, async () => {
        await expect(
          handleCaptureJob(
            job,
            mockLogger,
            { db, storage, redis },
            { finalAttempt: true },
          ),
        ).rejects.toThrow(/capture URL blocked/);
      });

      expect(await runStatus(job.runId)).toBe("aborted");
      expect(events.find((e) => e.type === "run.completed")?.status).toBe(
        "aborted",
      );
    }, 60_000);

    it("a failed attempt followed by a successful retry does not leave the run aborted", async () => {
      // Reserve a port, free it, and only bring the page up after attempt 1:
      // the first capture is refused, the retry succeeds.
      const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((r) => probe.close(() => r()));

      const job = await seedJob(`http://127.0.0.1:${port}/?u=retry-${uniq}`);

      await expect(
        handleCaptureJob(
          job,
          mockLogger,
          { db, storage, redis },
          { finalAttempt: false },
        ),
      ).rejects.toThrow();
      expect(await runStatus(job.runId)).toBe("running");

      let page: Server | undefined;
      try {
        page = createServer((req, res) => {
          const u =
            new URL(req.url ?? "/", "http://x").searchParams.get("u") ?? "";
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<!DOCTYPE html><html><body><p>retry ${u}</p></body></html>`);
        });
        await new Promise<void>((r) =>
          page!.listen(port, "127.0.0.1", () => r()),
        );

        // BullMQ's retry (here the last attempt) captures successfully.
        await handleCaptureJob(
          job,
          mockLogger,
          { db, storage, redis },
          { finalAttempt: true },
        );
      } finally {
        if (page) await new Promise<void>((r) => page!.close(() => r()));
      }

      // Capture leaves the run `running`; the diff-worker derives the rest.
      expect(await runStatus(job.runId)).toBe("running");
      const shots = await db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(eq(screenshots.runId, job.runId));
      expect(shots).toHaveLength(1);
    }, 60_000);
  },
);
