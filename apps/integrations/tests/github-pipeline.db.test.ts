import { randomUUID } from "node:crypto";

import {
  builds,
  createDb,
  eq,
  inArray,
  installations,
  projects,
  testRuns,
  type DB,
} from "@furan/db";
import { createRedisConnection } from "@furan/queue";
import type { Redis } from "ioredis";
import type { App, Octokit } from "octokit";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { startRunEventsSubscriber } from "../src/run-events/subscriber.js";

/**
 * The whole path with the real parts: a `run.completed` frame published on
 * Redis the way the diff-worker publishes it (none of the GitHub fields), the
 * real subscriber, the real database, and a fake GitHub. Skipped without a
 * database and Redis, like the other integration tests.
 */
const d =
  process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;

const BASE = "https://furan.example.com";

d("run.completed over Redis → PR comment and commit status", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let pub: Redis;
  let sub: Redis;
  let subscription: { close: () => Promise<void> };
  let projectId: string;
  let buildId: string;
  const installationId = 2_000_000 + Math.floor(Math.random() * 1e9);

  const createCommitStatus = vi.fn().mockResolvedValue({ data: {} });
  const listComments = vi.fn().mockResolvedValue({ data: [] });
  const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const octokit = {
    rest: {
      repos: { createCommitStatus },
      issues: { listComments, createComment, updateComment: vi.fn() },
    },
  } as unknown as Octokit;
  const getInstallationOctokit = vi.fn(async () => octokit);
  const githubApp = { getInstallationOctokit } as unknown as App;
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => log,
  };

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;

    const [project] = await db
      .insert(projects)
      .values({ name: `gh-pipeline-${randomUUID()}` })
      .returning();
    projectId = project!.id;
    const [build] = await db
      .insert(builds)
      .values({ projectId, isRunning: true })
      .returning();
    buildId = build!.id;
    await db
      .insert(installations)
      .values({ installationId, accountLogin: "acme", projectId });

    pub = createRedisConnection();
    sub = createRedisConnection();
    subscription = startRunEventsSubscriber({
      redis: sub,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: log as any,
      githubApp,
      db,
      dashboardBaseUrl: BASE,
    });
    // Let the PSUBSCRIBE register before the first publish.
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        expect.anything(),
        "run_events_subscribed",
      ),
    );
  });

  afterAll(async () => {
    await subscription.close();
    sub.disconnect();
    pub.disconnect();
    await db
      .delete(installations)
      .where(inArray(installations.installationId, [installationId]));
    await db.delete(projects).where(eq(projects.id, projectId));
    await closeDb();
  });

  async function insertRun(
    name: string,
    status: "passed" | "unresolved" | "running",
    createdAt: Date,
    context: boolean,
  ): Promise<string> {
    const [row] = await db
      .insert(testRuns)
      .values({
        projectId,
        buildId,
        name,
        status,
        createdAt,
        ...(context
          ? {
              repoOwner: "acme",
              repoName: "site",
              prNumber: 12,
              commitSha: "0123456789abcdef0123456789abcdef01234567",
            }
          : {}),
      })
      .returning({ id: testRuns.id });
    return row!.id;
  }

  /** The frame the diff-worker publishes: no GitHub fields. */
  const publishCompleted = (runId: string, status: string) =>
    pub.publish(
      `run:${runId}:events`,
      JSON.stringify({ type: "run.completed", runId, projectId, status }),
    );

  test("a run from CI yields the sticky comment and a build-wide furan/baselines status", async () => {
    // Two tests of one build: login still needs review, checkout just passed.
    await insertRun(
      "login",
      "unresolved",
      new Date("2026-01-01T00:00:00Z"),
      true,
    );
    const checkout = await insertRun(
      "checkout",
      "passed",
      new Date("2026-01-01T00:00:05Z"),
      true,
    );

    await publishCompleted(checkout, "passed");

    await vi.waitFor(() => expect(createCommitStatus).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));

    expect(getInstallationOctokit).toHaveBeenCalledWith(installationId);

    // The gate stays red: checkout passed, login is unresolved.
    expect(createCommitStatus.mock.calls[0]?.[0]).toMatchObject({
      owner: "acme",
      repo: "site",
      sha: "0123456789abcdef0123456789abcdef01234567",
      context: "furan/baselines",
      state: "failure",
      target_url: `${BASE}/projects/${projectId}/builds/${buildId}`,
    });
    expect(
      (createCommitStatus.mock.calls[0]?.[0] as { description: string })
        .description,
    ).toContain("(1 of 2 tests)");

    // The comment is about the run that completed: it passed.
    const comment = createComment.mock.calls[0]?.[0] as {
      issue_number: number;
      body: string;
    };
    expect(comment.issue_number).toBe(12);
    expect(comment.body).toContain(`<!-- furan-run-${checkout} -->`);
    expect(comment.body).toContain("🟢");
    expect(comment.body).toContain(
      `${BASE}/projects/${projectId}/runs/${checkout}`,
    );
  });

  test("a run the SDK sent no context for is skipped, not an error", async () => {
    const statusCalls = createCommitStatus.mock.calls.length;
    const bare = await insertRun(
      "no-context",
      "passed",
      new Date("2026-01-01T00:00:10Z"),
      false,
    );

    await publishCompleted(bare, "passed");

    await vi.waitFor(() =>
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: bare,
          missing: expect.arrayContaining(["repoOwner", "repoName", "sha"]),
        }),
        "run_completed_skipped_missing_github_fields",
      ),
    );
    expect(createCommitStatus).toHaveBeenCalledTimes(statusCalls);
    expect(log.error).not.toHaveBeenCalled();
  });
});
