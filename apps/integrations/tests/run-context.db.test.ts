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
import type { RunStatus } from "@furan/shared-types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  loadBuildStatusCounts,
  loadRunContext,
  resolveInstallationId,
} from "../src/github/run-context.js";

/**
 * DB-backed: the SQL (latest run per test name, the installation tie-break) is
 * the part a mock cannot vouch for. Skipped when `DATABASE_URL` is unset, like
 * the other database tests.
 */
const d = process.env.DATABASE_URL ? describe : describe.skip;

/** A positive int32 that will not collide with another test file's rows. */
const uniqueInstallationId = () => 1_000_000 + Math.floor(Math.random() * 1e9);

d("GitHub run context reads", () => {
  let db: DB;
  let close: () => Promise<void>;
  let projectId: string;
  let buildId: string;
  const installationIds: number[] = [];

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;
    const [project] = await db
      .insert(projects)
      .values({ name: `gh-context-${randomUUID()}` })
      .returning();
    projectId = project!.id;
    const [build] = await db
      .insert(builds)
      .values({ projectId, isRunning: true })
      .returning();
    buildId = build!.id;
  });

  afterAll(async () => {
    if (installationIds.length > 0) {
      await db
        .delete(installations)
        .where(inArray(installations.installationId, installationIds));
    }
    // Cascades to the builds, runs and linked installations below it.
    await db.delete(projects).where(eq(projects.id, projectId));
    await close();
  });

  async function insertRun(opts: {
    name: string;
    status: RunStatus;
    createdAt: Date;
    buildId?: string;
    repo?: { owner: string; name: string; pr: number | null; sha: string };
  }): Promise<string> {
    const [row] = await db
      .insert(testRuns)
      .values({
        projectId,
        buildId: opts.buildId ?? buildId,
        name: opts.name,
        status: opts.status,
        createdAt: opts.createdAt,
        ...(opts.repo
          ? {
              repoOwner: opts.repo.owner,
              repoName: opts.repo.name,
              prNumber: opts.repo.pr,
              commitSha: opts.repo.sha,
            }
          : {}),
      })
      .returning({ id: testRuns.id });
    return row!.id;
  }

  async function insertInstallation(opts: {
    accountLogin: string;
    projectId: string | null;
    createdAt: Date;
  }): Promise<number> {
    const installationId = uniqueInstallationId();
    installationIds.push(installationId);
    await db.insert(installations).values({
      installationId,
      accountLogin: opts.accountLogin,
      projectId: opts.projectId,
      createdAt: opts.createdAt,
    });
    return installationId;
  }

  describe("loadRunContext", () => {
    test("returns the run's project, build, status and source-control context", async () => {
      const runId = await insertRun({
        name: "ctx-hit",
        status: "unresolved",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        repo: { owner: "acme", name: "site", pr: 7, sha: "deadbeef" },
      });
      expect(await loadRunContext(db, runId)).toEqual({
        projectId,
        buildId,
        status: "unresolved",
        repoOwner: "acme",
        repoName: "site",
        prNumber: 7,
        commitSha: "deadbeef",
      });
    });

    test("a run without context reports nulls (push build / older SDK)", async () => {
      const runId = await insertRun({
        name: "ctx-bare",
        status: "passed",
        createdAt: new Date("2026-01-01T00:00:01Z"),
      });
      expect(await loadRunContext(db, runId)).toMatchObject({
        repoOwner: null,
        repoName: null,
        prNumber: null,
        commitSha: null,
      });
    });

    test("an unknown run id, and an id that is not a uuid, are null (no throw)", async () => {
      expect(await loadRunContext(db, randomUUID())).toBeNull();
      expect(await loadRunContext(db, "run-1")).toBeNull();
    });
  });

  describe("resolveInstallationId", () => {
    test("null when no installation is linked to the project", async () => {
      const [other] = await db
        .insert(projects)
        .values({ name: `gh-context-unlinked-${randomUUID()}` })
        .returning();
      try {
        expect(await resolveInstallationId(db, other!.id, "acme")).toBeNull();
      } finally {
        await db.delete(projects).where(eq(projects.id, other!.id));
      }
    });

    test("ignores installations linked to other projects or to none", async () => {
      await insertInstallation({
        accountLogin: "acme",
        projectId: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      const [other] = await db
        .insert(projects)
        .values({ name: `gh-context-other-${randomUUID()}` })
        .returning();
      try {
        const id = await insertInstallation({
          accountLogin: "acme",
          projectId: other!.id,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        });
        expect(id).toBeGreaterThan(0);
        expect(await resolveInstallationId(db, projectId, "acme")).toBeNull();
      } finally {
        await db.delete(projects).where(eq(projects.id, other!.id));
      }
    });

    test("several installations: the one whose account is the repo owner wins, case-insensitively", async () => {
      const first = await insertInstallation({
        accountLogin: "someone-else",
        projectId,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      const owner = await insertInstallation({
        accountLogin: "Acme-Corp",
        projectId,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      });
      expect(await resolveInstallationId(db, projectId, "acme-corp")).toBe(
        owner,
      );
      // No owner match: the oldest link is the fallback, deterministically.
      expect(await resolveInstallationId(db, projectId, "nobody")).toBe(first);
      expect(await resolveInstallationId(db, projectId, null)).toBe(first);
    });
  });

  describe("loadBuildStatusCounts", () => {
    test("counts only the latest run of each test name (a rerun replaces its earlier run)", async () => {
      const [build] = await db
        .insert(builds)
        .values({ projectId, isRunning: true })
        .returning();
      const b = build!.id;
      const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
      // checkout: aborted first, then re-run and passed → counts once, as passed.
      await insertRun({
        buildId: b,
        name: "checkout",
        status: "aborted",
        createdAt: t(1),
      });
      await insertRun({
        buildId: b,
        name: "checkout",
        status: "passed",
        createdAt: t(5),
      });
      // login: still unresolved.
      await insertRun({
        buildId: b,
        name: "login",
        status: "unresolved",
        createdAt: t(2),
      });
      // search: two runs, the later one is running.
      await insertRun({
        buildId: b,
        name: "search",
        status: "passed",
        createdAt: t(3),
      });
      await insertRun({
        buildId: b,
        name: "search",
        status: "running",
        createdAt: t(4),
      });

      expect(await loadBuildStatusCounts(db, b)).toEqual({
        passed: 1,
        unresolved: 1,
        running: 1,
      });
    });

    test("a build with no runs has no counts", async () => {
      const [build] = await db
        .insert(builds)
        .values({ projectId, isRunning: true })
        .returning();
      expect(await loadBuildStatusCounts(db, build!.id)).toEqual({});
    });
  });
});
