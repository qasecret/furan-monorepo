import type { RunStatus } from "@furan/shared-types";
import type { App, Octokit } from "octokit";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { handleRunCompleted } from "../src/run-events/handle-run-completed.js";

/**
 * Per-status table for the GitHub state and the emoji that must appear
 * in the sticky-comment body. Spec §3.4.
 */
const STATUS_TABLE: Array<{
  status: RunStatus;
  expectedState: string;
  expectedEmoji: string;
}> = [
  { status: "running", expectedState: "pending", expectedEmoji: "🔵" },
  { status: "new", expectedState: "success", expectedEmoji: "⚪" },
  { status: "passed", expectedState: "success", expectedEmoji: "🟢" },
  { status: "unresolved", expectedState: "failure", expectedEmoji: "🟡" },
  { status: "failed", expectedState: "failure", expectedEmoji: "🔴" },
  { status: "aborted", expectedState: "error", expectedEmoji: "⚠️" },
  { status: "empty", expectedState: "failure", expectedEmoji: "⚪" },
];

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

  const githubApp = {
    getInstallationOctokit: vi.fn(async () => octokit),
  } as unknown as App;

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
    octokit,
    log,
    createCommitStatus,
    createComment,
    listComments,
  };
}

function baseEvent() {
  return {
    type: "run.completed" as const,
    runId: "run-1",
    projectId: "proj-1",
    installationId: 12345,
    repoOwner: "acme",
    repoName: "site",
    sha: "deadbeef",
    prNumber: 7,
    dashboardUrl: "https://app.furan.dev/r/1",
  };
}

describe("handleRunCompleted GitHub state mapping (spec §3.4)", () => {
  for (const { status, expectedState, expectedEmoji } of STATUS_TABLE) {
    test(`status=${status} → GitHub state=${expectedState}`, async () => {
      const { githubApp, log, createCommitStatus, createComment } =
        buildMocks();

      await handleRunCompleted({
        githubApp,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        log: log as any,
        event: { ...baseEvent(), status },
      });

      // GitHub commit-status state matches the mapping table.
      expect(createCommitStatus).toHaveBeenCalledTimes(1);
      const statusArgs = createCommitStatus.mock.calls[0]?.[0] as {
        state: string;
        description: string;
      };
      expect(statusArgs.state).toBe(expectedState);
      // Description comes from `presentationFor` and is non-empty.
      expect(statusArgs.description.length).toBeGreaterThan(0);

      // Sticky PR comment carries the status emoji + description.
      expect(createComment).toHaveBeenCalledTimes(1);
      const commentArgs = createComment.mock.calls[0]?.[0] as { body: string };
      expect(commentArgs.body).toContain(expectedEmoji);
    });
  }

  test("unresolved → failure (load-bearing: blocks merge)", async () => {
    // The whole point of the 7-status split is that Unresolved must
    // block the PR until a reviewer acts. If this ever maps to
    // `pending`, silent merges of unreviewed diffs become possible.
    const { githubApp, log, createCommitStatus } = buildMocks();
    await handleRunCompleted({
      githubApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: log as any,
      event: { ...baseEvent(), status: "unresolved" },
    });
    const args = createCommitStatus.mock.calls[0]?.[0] as { state: string };
    expect(args.state).toBe("failure");
    expect(args.state).not.toBe("pending");
  });

  test("aborted → error (load-bearing: distinct from failure)", async () => {
    const { githubApp, log, createCommitStatus } = buildMocks();
    await handleRunCompleted({
      githubApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: log as any,
      event: { ...baseEvent(), status: "aborted" },
    });
    const args = createCommitStatus.mock.calls[0]?.[0] as { state: string };
    expect(args.state).toBe("error");
    expect(args.state).not.toBe("failure");
  });

  test("missing GitHub fields → no Octokit calls", async () => {
    const { githubApp, log, createCommitStatus, createComment } = buildMocks();
    await handleRunCompleted({
      githubApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: log as any,
      event: {
        type: "run.completed",
        runId: "run-1",
        status: "passed",
        // installationId/repoOwner/repoName/sha/prNumber all omitted
      },
    });
    expect(createCommitStatus).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe("handleRunCompleted PR comment body (spec §3.4)", () => {
  test("body includes change count when numChanges > 0", async () => {
    const { githubApp, log, createComment } = buildMocks();
    await handleRunCompleted({
      githubApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: log as any,
      event: { ...baseEvent(), status: "unresolved", numChanges: 3 },
    });
    const args = createComment.mock.calls[0]?.[0] as { body: string };
    expect(args.body).toContain("3 changes");
  });

  test("body uses singular 'change' for numChanges=1", async () => {
    const { githubApp, log, createComment } = buildMocks();
    await handleRunCompleted({
      githubApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: log as any,
      event: { ...baseEvent(), status: "unresolved", numChanges: 1 },
    });
    const args = createComment.mock.calls[0]?.[0] as { body: string };
    expect(args.body).toContain("1 change");
    expect(args.body).not.toContain("1 changes");
  });

  test("body links to dashboardUrl when provided", async () => {
    const { githubApp, log, createComment } = buildMocks();
    await handleRunCompleted({
      githubApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: log as any,
      event: {
        ...baseEvent(),
        status: "passed",
        dashboardUrl: "https://app.furan.dev/x",
      },
    });
    const args = createComment.mock.calls[0]?.[0] as { body: string };
    expect(args.body).toContain("https://app.furan.dev/x");
  });
});

describe("handleRunCompleted fallback when status missing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("missing status defaults to running (→ pending) — does not mis-report", async () => {
    const { githubApp, log, createCommitStatus } = buildMocks();
    await handleRunCompleted({
      githubApp,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: log as any,
      event: { ...baseEvent(), status: undefined as unknown as RunStatus },
    });
    const args = createCommitStatus.mock.calls[0]?.[0] as { state: string };
    expect(args.state).toBe("pending");
  });
});
