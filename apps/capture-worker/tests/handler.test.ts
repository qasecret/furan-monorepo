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
  let seededProjectId: string | undefined;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);

    // Responsive fixture with a query-string-driven unique body, so each
    // test can use its own URL to bypass the global UNIQUE constraint on
    // screenshots.image_key across tests. The `?u=...` querystring is
    // rendered into the page so two tests requesting different `u` get
    // distinct content-addressed image keys.
    fixtureServer = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x").searchParams.get("u") ?? "";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<!DOCTYPE html><html><head><style>
          html,body{margin:0;padding:0;font-family:sans-serif;}
          .a{display:block;background:#0a0;color:#fff;height:200px;width:100vw;}
          .b{display:block;background:#a00;color:#fff;height:80vh;width:100vw;}
          @media (max-width:600px){.a{background:#00a;height:400px;} .b{background:#0aa;}}
        </style></head><body>
          <div class="a"><h1>Furan capture fixture</h1></div>
          <div class="b"><p>hello world ${u}</p></div>
        </body></html>`,
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
    seededProjectId = p.id;
  }, 60_000);

  afterAll(async () => {
    // Cascade-delete the test's project so screenshots/test_runs etc. don't
    // leak into the next run (the screenshots.image_key UNIQUE constraint
    // would otherwise block a re-run on identical Playwright output).
    try {
      if (db && seededProjectId) {
        await db.delete(projects).where(eq(projects.id, seededProjectId));
      }
    } catch {
      // best-effort cleanup
    }
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

  test("multi-viewport: captures one screenshots row per viewport (v0.5)", async () => {
    // Seed a fresh run that's separate from the single-viewport test so
    // the unique image_key constraint can still fire if Playwright produces
    // identical bytes for the 1280x720 capture (defensive — the 375x812
    // shot will differ from the prior single-viewport test's content).
    const uniq = Date.now();
    const [u] = await db
      .insert(users)
      .values({
        email: `cw-mv-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "cw",
        lastName: "mv",
        role: "admin",
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({ name: `cw-mv-${uniq}` })
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
        name: "r-mv",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "main",
        status: "running",
      })
      .returning();

    const mvJob: CaptureJob = {
      runId: r.id,
      projectId: p.id,
      buildId: b.id,
      testVariationId: v.id,
      // Per-test unique URL so the responsive fixture renders distinct
      // bytes vs the single-viewport test above (image_key is a global
      // UNIQUE constraint).
      url: `${fixtureUrl}/?u=mv-${uniq}`,
      viewports: [
        { width: 1280, height: 720 },
        { width: 375, height: 812 },
      ],
      browser: "chromium",
    };

    const events: string[] = [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(`run:${r.id}:events`);
    sub.on("message", (_channel, message) => events.push(message));
    await new Promise((res) => setTimeout(res, 100));

    try {
      await handleCaptureJob(mvJob, mockLogger, { db, storage, redis });

      const shots = await db.query.screenshots.findMany({
        where: eq(screenshots.runId, r.id),
      });
      expect(shots.length).toBe(2);
      const viewports = shots.map((s) => s.viewport).sort();
      expect(viewports).toEqual(["1280x720", "375x812"]);
      // Distinct image keys per viewport (different content sizes ⇒ distinct hashes).
      const keys = new Set(shots.map((s) => s.imageKey));
      expect(keys.size).toBe(2);

      // Two capture.started + one capture.completed expected.
      await new Promise((res) => setTimeout(res, 200));
      const types = events.map((e) => JSON.parse(e).type as string);
      const startedCount = types.filter((t) => t === "capture.started").length;
      const completedCount = types.filter(
        (t) => t === "capture.completed",
      ).length;
      expect(startedCount).toBe(2);
      expect(completedCount).toBe(1);
      const completed = events
        .map((e) => JSON.parse(e))
        .find((e) => e.type === "capture.completed");
      expect(completed.viewportCount).toBe(2);
    } finally {
      sub.disconnect();
      // Per-test scoped cleanup: cascade-delete this single project so
      // the next test starts clean (and concurrency=1 leaves no leakage).
      await db.delete(projects).where(eq(projects.id, p.id));
    }
  }, 90_000);
});
