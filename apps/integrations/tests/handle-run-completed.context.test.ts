import type { DB } from "@furan/db";
import type { App, Octokit } from "octokit";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createPostMemo, type PostMemo } from "../src/github/post-memo.js";
import {
  loadBuildStatusCounts,
  loadRunContext,
  resolveInstallationId,
  type RunContextRow,
} from "../src/github/run-context.js";
import { handleRunCompleted } from "../src/run-events/handle-run-completed.js";

vi.mock("../src/github/run-context.js", () => ({
  loadRunContext: vi.fn(),
  resolveInstallationId: vi.fn(),
  loadBuildStatusCounts: vi.fn(),
}));

/**
 * The consumer fills in what the publishers leave out: it reads the run's
 * repository / pull request / commit from the database and the installation
 * from the project's link. Event-supplied fields still win.
 */

const db = {} as DB;
const BASE = "https://furan.example.com";

const ROW: RunContextRow = {
  projectId: "proj-1",
  buildId: "build-1",
  status: "unresolved",
  repoOwner: "acme",
  repoName: "site",
  prNumber: 7,
  commitSha: "cafe1234",
};

function buildMocks() {
  const createCommitStatus = vi.fn().mockResolvedValue({ data: {} });
  const listComments = vi.fn().mockResolvedValue({ data: [] });
  const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const updateComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const octokit = {
    rest: {
      repos: { createCommitStatus },
      issues: { listComments, createComment, updateComment },
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
  return {
    githubApp,
    getInstallationOctokit,
    log,
    createCommitStatus,
    createComment,
    updateComment,
  };
}

/** An event as the diff-worker publishes it: no GitHub fields at all. */
const bareEvent = (extra: Record<string, unknown> = {}) => ({
  type: "run.completed" as const,
  runId: "run-1",
  projectId: "proj-1",
  ...extra,
});

async function run(
  mocks: ReturnType<typeof buildMocks>,
  event: ReturnType<typeof bareEvent>,
  extra: {
    dashboardBaseUrl?: string;
    withDb?: boolean;
    postMemo?: PostMemo;
  } = {},
) {
  await handleRunCompleted({
    githubApp: mocks.githubApp,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log: mocks.log as any,
    event,
    ...(extra.withDb === false ? {} : { db }),
    ...(extra.dashboardBaseUrl
      ? { dashboardBaseUrl: extra.dashboardBaseUrl }
      : {}),
    ...(extra.postMemo ? { postMemo: extra.postMemo } : {}),
  });
}

beforeEach(() => {
  vi.mocked(loadRunContext).mockReset().mockResolvedValue(ROW);
  vi.mocked(resolveInstallationId).mockReset().mockResolvedValue(999);
  vi.mocked(loadBuildStatusCounts)
    .mockReset()
    .mockResolvedValue({ unresolved: 1 });
});

describe("handleRunCompleted fills the GitHub fields from the database", () => {
  test("an event with none of them still posts the sticky comment and the status", async () => {
    const m = buildMocks();
    await run(m, bareEvent({ status: "unresolved" }));

    expect(loadRunContext).toHaveBeenCalledWith(db, "run-1");
    expect(resolveInstallationId).toHaveBeenCalledWith(db, "proj-1", "acme");
    expect(m.getInstallationOctokit).toHaveBeenCalledWith(999);

    expect(m.createCommitStatus).toHaveBeenCalledTimes(1);
    expect(m.createCommitStatus.mock.calls[0]?.[0]).toMatchObject({
      owner: "acme",
      repo: "site",
      sha: "cafe1234",
      state: "failure",
      context: "furan/baselines",
    });

    expect(m.createComment).toHaveBeenCalledTimes(1);
    const comment = m.createComment.mock.calls[0]?.[0] as {
      issue_number: number;
      body: string;
    };
    expect(comment.issue_number).toBe(7);
    expect(comment.body).toContain("<!-- furan-run-run-1 -->");
  });

  test("event-supplied fields win over the database and skip the installation lookup", async () => {
    const m = buildMocks();
    await run(
      m,
      bareEvent({
        status: "passed",
        installationId: 5,
        repoOwner: "evt-owner",
        repoName: "evt-repo",
        sha: "beef0001",
        prNumber: 9,
      }),
    );

    expect(resolveInstallationId).not.toHaveBeenCalled();
    expect(m.getInstallationOctokit).toHaveBeenCalledWith(5);
    expect(m.createCommitStatus.mock.calls[0]?.[0]).toMatchObject({
      owner: "evt-owner",
      repo: "evt-repo",
      sha: "beef0001",
    });
    expect(
      (m.createComment.mock.calls[0]?.[0] as { issue_number: number })
        .issue_number,
    ).toBe(9);
  });

  test("a push build (a commit, no pull request) posts the status and no comment", async () => {
    vi.mocked(loadRunContext).mockResolvedValue({ ...ROW, prNumber: null });
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }));

    expect(m.createCommitStatus).toHaveBeenCalledTimes(1);
    expect(m.createComment).not.toHaveBeenCalled();
    expect(m.updateComment).not.toHaveBeenCalled();
  });

  test("the comment shows the run's stored status when the event carries none (api events)", async () => {
    const m = buildMocks();
    await run(m, bareEvent());
    const comment = m.createComment.mock.calls[0]?.[0] as { body: string };
    // `unresolved` → 🟡, from the stored row, not the "running" fallback.
    expect(comment.body).toContain("🟡");
  });
});

describe("handleRunCompleted skips quietly when the context is incomplete", () => {
  test("no installation is linked to the project → no Octokit, no calls", async () => {
    vi.mocked(resolveInstallationId).mockResolvedValue(null);
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }));

    expect(m.getInstallationOctokit).not.toHaveBeenCalled();
    expect(m.createCommitStatus).not.toHaveBeenCalled();
    expect(m.createComment).not.toHaveBeenCalled();
    expect(m.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ["installationId"] }),
      "run_completed_skipped_missing_github_fields",
    );
  });

  test("a run the SDK sent no repo or commit for → skipped, naming the gaps", async () => {
    vi.mocked(loadRunContext).mockResolvedValue({
      ...ROW,
      repoOwner: null,
      repoName: null,
      commitSha: null,
    });
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }));

    expect(m.createCommitStatus).not.toHaveBeenCalled();
    expect(resolveInstallationId).not.toHaveBeenCalled();
    expect(m.log.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        missing: expect.arrayContaining(["repoOwner", "repoName", "sha"]),
      }),
      "run_completed_skipped_missing_github_fields",
    );
  });

  test("an unknown run → skipped", async () => {
    vi.mocked(loadRunContext).mockResolvedValue(null);
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }));
    expect(m.createCommitStatus).not.toHaveBeenCalled();
  });

  test("without a db the handler behaves as before: the event must carry the fields", async () => {
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }), { withDb: false });
    expect(loadRunContext).not.toHaveBeenCalled();
    expect(m.createCommitStatus).not.toHaveBeenCalled();
  });

  test("a failing context lookup is a warning, and complete events still post", async () => {
    vi.mocked(loadRunContext).mockRejectedValue(new Error("db down"));
    vi.mocked(loadBuildStatusCounts).mockRejectedValue(new Error("db down"));
    const m = buildMocks();
    await run(
      m,
      bareEvent({
        status: "passed",
        installationId: 5,
        repoOwner: "acme",
        repoName: "site",
        sha: "beef0001",
        prNumber: 3,
      }),
    );

    expect(m.log.warn).toHaveBeenCalled();
    expect(m.createCommitStatus).toHaveBeenCalledTimes(1);
    expect(m.createCommitStatus.mock.calls[0]?.[0]).toMatchObject({
      state: "success",
    });
  });

  test("a failing installation lookup is a warning and a skip", async () => {
    vi.mocked(resolveInstallationId).mockRejectedValue(new Error("db down"));
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }));
    expect(m.log.warn).toHaveBeenCalled();
    expect(m.createCommitStatus).not.toHaveBeenCalled();
  });
});

describe("handleRunCompleted posts the build-wide status", () => {
  test("a later passing test cannot turn the gate green while another test is unresolved", async () => {
    vi.mocked(loadBuildStatusCounts).mockResolvedValue({
      unresolved: 2,
      passed: 12,
    });
    const m = buildMocks();
    // This run passed; the build still has two unresolved tests.
    await run(m, bareEvent({ status: "passed" }), { dashboardBaseUrl: BASE });

    expect(loadBuildStatusCounts).toHaveBeenCalledWith(db, "build-1");
    const status = m.createCommitStatus.mock.calls[0]?.[0] as {
      state: string;
      description: string;
      target_url?: string;
    };
    expect(status.state).toBe("failure");
    expect(status.description).toContain("(2 of 14 tests)");
    expect(status.target_url).toBe(`${BASE}/projects/proj-1/builds/build-1`);

    // The comment is still about this run: it passed.
    const comment = m.createComment.mock.calls[0]?.[0] as { body: string };
    expect(comment.body).toContain("🟢");
  });

  test("stays pending while any test in the build is still running", async () => {
    vi.mocked(loadBuildStatusCounts).mockResolvedValue({
      running: 1,
      passed: 3,
    });
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }));
    expect(m.createCommitStatus.mock.calls[0]?.[0]).toMatchObject({
      state: "pending",
    });
  });

  test("a single-test build keeps the run-level wording, including the change count", async () => {
    vi.mocked(loadBuildStatusCounts).mockResolvedValue({ unresolved: 1 });
    const m = buildMocks();
    await run(m, bareEvent({ status: "unresolved", numChanges: 3 }));
    const status = m.createCommitStatus.mock.calls[0]?.[0] as {
      description: string;
    };
    expect(status.description).toMatch(/\(3 changes\)$/);
    expect(status.description).not.toContain("tests)");
  });

  test("a build with no counts falls back to the run's own status", async () => {
    vi.mocked(loadBuildStatusCounts).mockResolvedValue({});
    const m = buildMocks();
    await run(m, bareEvent({ status: "aborted" }));
    expect(m.createCommitStatus.mock.calls[0]?.[0]).toMatchObject({
      state: "error",
    });
  });
});

describe("handleRunCompleted dashboard links", () => {
  test("the comment links to the run page under DASHBOARD_BASE_URL", async () => {
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }), { dashboardBaseUrl: BASE });
    const comment = m.createComment.mock.calls[0]?.[0] as { body: string };
    expect(comment.body).toContain(`${BASE}/projects/proj-1/runs/run-1`);
  });

  test("an event's own dashboardUrl wins", async () => {
    const m = buildMocks();
    await run(
      m,
      bareEvent({ status: "passed", dashboardUrl: "https://x.example/r/1" }),
      { dashboardBaseUrl: BASE },
    );
    const comment = m.createComment.mock.calls[0]?.[0] as { body: string };
    expect(comment.body).toContain("https://x.example/r/1");
    expect(comment.body).not.toContain(BASE);
  });

  test("without a base URL there is no link, as before", async () => {
    const m = buildMocks();
    await run(m, bareEvent({ status: "passed" }));
    const comment = m.createComment.mock.calls[0]?.[0] as { body: string };
    expect(comment.body).not.toContain("View run details");
  });
});

describe("handleRunCompleted when GitHub refuses", () => {
  test("a rejected status (repo outside the installation) is logged, not thrown, and the comment is still attempted", async () => {
    const m = buildMocks();
    m.createCommitStatus.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    await expect(run(m, bareEvent({ status: "passed" }))).resolves.toBe(
      undefined,
    );

    expect(m.createComment).toHaveBeenCalledTimes(1);
    expect(m.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1" }),
      "run_completed_github_update_failed",
    );
    expect(m.log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "run_completed_github_updated",
    );
  });

  test("a failure minting the installation token is logged and returns", async () => {
    const m = buildMocks();
    m.getInstallationOctokit.mockRejectedValue(new Error("bad key"));
    await run(m, bareEvent({ status: "passed" }));
    expect(m.createCommitStatus).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 999 }),
      "run_completed_installation_octokit_failed",
    );
  });
});

describe("handleRunCompleted does not repeat an unchanged commit status", () => {
  // A review re-reports runs whose status did not move (one checkpoint of
  // many approved, or a whole build approved run by run). GitHub keeps every
  // status posted and caps them at 1000 per commit and context, so an
  // identical one is not posted again.
  test("the same state and description is posted once", async () => {
    const postMemo = createPostMemo();
    const m = buildMocks();
    await run(m, bareEvent({ status: "unresolved" }), { postMemo });
    await run(m, bareEvent({ status: "unresolved" }), { postMemo });

    expect(m.createCommitStatus).toHaveBeenCalledTimes(1);
  });

  test("a different state is posted, and so is a different description", async () => {
    const postMemo = createPostMemo();
    const m = buildMocks();
    vi.mocked(loadBuildStatusCounts).mockResolvedValue({
      unresolved: 1,
      passed: 1,
    });
    await run(m, bareEvent({ status: "passed" }), { postMemo });

    // The unresolved test is reviewed: the build is now all passed.
    vi.mocked(loadBuildStatusCounts).mockResolvedValue({ passed: 2 });
    await run(m, bareEvent({ status: "passed" }), { postMemo });

    expect(m.createCommitStatus).toHaveBeenCalledTimes(2);
    expect(m.createCommitStatus.mock.calls[0]?.[0]).toMatchObject({
      state: "failure",
    });
    expect(m.createCommitStatus.mock.calls[1]?.[0]).toMatchObject({
      state: "success",
    });
  });

  test("a status that failed to post is not remembered, so it is retried", async () => {
    const postMemo = createPostMemo();
    const m = buildMocks();
    m.createCommitStatus.mockRejectedValueOnce(new Error("boom"));
    await run(m, bareEvent({ status: "passed" }), { postMemo });
    await run(m, bareEvent({ status: "passed" }), { postMemo });

    expect(m.createCommitStatus).toHaveBeenCalledTimes(2);
  });

  test("an unchanged status still lets the run's own comment through", async () => {
    const postMemo = createPostMemo();
    const m = buildMocks();
    await run(m, bareEvent({ status: "unresolved" }), { postMemo });
    await run(m, bareEvent({ status: "unresolved" }), { postMemo });

    // The comment upsert decides for itself (it lists, and skips an identical
    // body): the handler asks it both times.
    expect(m.createComment).toHaveBeenCalledTimes(2);
  });

  test("without a memo every call posts (the previous behaviour)", async () => {
    const m = buildMocks();
    await run(m, bareEvent({ status: "unresolved" }));
    await run(m, bareEvent({ status: "unresolved" }));
    expect(m.createCommitStatus).toHaveBeenCalledTimes(2);
  });
});
