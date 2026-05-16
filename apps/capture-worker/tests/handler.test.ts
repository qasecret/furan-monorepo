import { createServer, type Server } from "node:http";

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
import { createStorage, objectKey, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { handleCaptureJob } from "../src/handler.js";
import { closeAllBrowsers } from "../src/playwright.js";

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
  // pino loggers return a child logger; cast as any to satisfy type
  // without pulling pino into the test dependency tree.
  child: () => mockLogger,
} as unknown as Parameters<typeof handleCaptureJob>[1];

desc("handleCaptureJob (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let fixtureServer: Server;
  let fixtureUrl: string;
  let job: CaptureJob;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);

    fixtureServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<!DOCTYPE html><html><body><h1>Furan capture fixture</h1><p>hello world</p></body></html>",
      );
    });
    await new Promise<void>((resolve) =>
      fixtureServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = fixtureServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    fixtureUrl = `http://127.0.0.1:${port}`;

    const uniq = Date.now();
    const [u] = await db
      .insert(users)
      .values({
        email: `cw-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "cw",
        lastName: "tester",
        role: "admin",
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({ name: `cw-${uniq}` })
      .returning();
    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId: u.id, isRunning: true })
      .returning();
    const [v] = await db
      .insert(testVariations)
      .values({
        name: "v",
        projectId: p.id,
        branchName: "main",
        browser: "chromium",
        viewport: "1280x720",
      })
      .returning();
    const [r] = await db
      .insert(testRuns)
      .values({
        name: "r",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "main",
        status: "running",
      })
      .returning();

    job = {
      runId: r.id,
      projectId: p.id,
      buildId: b.id,
      testVariationId: v.id,
      url: fixtureUrl,
      viewport: { width: 1280, height: 720 },
      browser: "chromium",
    };
  }, 60_000);

  afterAll(async () => {
    await closeAllBrowsers();
    if (closeDb) await closeDb();
    if (redis) redis.disconnect();
    if (fixtureServer)
      await new Promise<void>((resolve) =>
        fixtureServer.close(() => resolve()),
      );
  });

  test("captures, stores at content-addressed key, inserts screenshots row, publishes events", async () => {
    const events: string[] = [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(`run:${job.runId}:events`);
    sub.on("message", (_channel, message) => events.push(message));

    // Let subscription settle before the handler publishes.
    await new Promise((r) => setTimeout(r, 100));

    await handleCaptureJob(job, mockLogger, { db, storage, redis });

    const shot = await db.query.screenshots.findFirst({
      where: eq(screenshots.runId, job.runId),
    });
    expect(shot).toBeDefined();
    expect(shot!.imageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(shot!.domKey).toMatch(/^[0-9a-f]{64}$/);
    expect(shot!.viewport).toBe("1280x720");
    expect(shot!.browser).toBe("chromium");
    expect(shot!.projectId).toBe(job.projectId);

    const fetched = await storage.get(shot!.imageKey);
    expect(fetched.byteLength).toBeGreaterThan(0);
    expect(objectKey(fetched)).toBe(shot!.imageKey);

    const fetchedDom = await storage.get(shot!.domKey!);
    expect(fetchedDom.byteLength).toBeGreaterThan(0);
    expect(objectKey(fetchedDom)).toBe(shot!.domKey);

    // Give redis pub/sub a moment to deliver the trailing event.
    await new Promise((r) => setTimeout(r, 200));
    const types = events.map((e) => JSON.parse(e).type as string);
    expect(types).toContain("capture.started");
    expect(types).toContain("capture.completed");

    sub.disconnect();
  }, 60_000);
});
