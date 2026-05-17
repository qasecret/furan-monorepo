import type { Octokit } from "octokit";
import { describe, expect, test, vi } from "vitest";

import {
  STATUS_CHECK_CONTEXT,
  createOrUpdateStatusCheck,
} from "../src/github/status-check.js";

function buildMockOctokit() {
  const createCommitStatus = vi.fn().mockResolvedValue({ data: {} });
  const octokit = {
    rest: { repos: { createCommitStatus } },
  } as unknown as Octokit;
  return { octokit, createCommitStatus };
}

describe("createOrUpdateStatusCheck", () => {
  test("posts a success status with the canonical context and target URL", async () => {
    const { octokit, createCommitStatus } = buildMockOctokit();

    await createOrUpdateStatusCheck({
      octokit,
      owner: "acme",
      repo: "site",
      sha: "deadbeef",
      state: "success",
      description: "all good",
      targetUrl: "https://app.furan.dev/runs/abc",
    });

    expect(createCommitStatus).toHaveBeenCalledTimes(1);
    const args = createCommitStatus.mock.calls[0]?.[0] as {
      owner: string;
      repo: string;
      sha: string;
      state: string;
      context: string;
      description: string;
      target_url?: string;
    };
    expect(args.owner).toBe("acme");
    expect(args.repo).toBe("site");
    expect(args.sha).toBe("deadbeef");
    expect(args.state).toBe("success");
    expect(args.context).toBe(STATUS_CHECK_CONTEXT);
    expect(args.context).toBe("furan/baselines");
    expect(args.description).toBe("all good");
    expect(args.target_url).toBe("https://app.furan.dev/runs/abc");
  });

  test("posts a failure status and omits target_url when not provided", async () => {
    const { octokit, createCommitStatus } = buildMockOctokit();

    await createOrUpdateStatusCheck({
      octokit,
      owner: "acme",
      repo: "site",
      sha: "cafe",
      state: "failure",
      description: "3 changes",
    });

    expect(createCommitStatus).toHaveBeenCalledTimes(1);
    const args = createCommitStatus.mock.calls[0]?.[0] as {
      state: string;
      context: string;
      target_url?: string;
    };
    expect(args.state).toBe("failure");
    expect(args.context).toBe("furan/baselines");
    expect(args.target_url).toBeUndefined();
  });

  test("supports pending state", async () => {
    const { octokit, createCommitStatus } = buildMockOctokit();
    await createOrUpdateStatusCheck({
      octokit,
      owner: "a",
      repo: "b",
      sha: "abc",
      state: "pending",
      description: "queued",
    });
    expect(createCommitStatus).toHaveBeenCalledTimes(1);
    const args = createCommitStatus.mock.calls[0]?.[0] as { state: string };
    expect(args.state).toBe("pending");
  });
});
