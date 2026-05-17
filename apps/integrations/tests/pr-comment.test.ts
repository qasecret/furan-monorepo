import type { Octokit } from "octokit";
import { describe, expect, test, vi } from "vitest";

import {
  createOrUpdateStickyComment,
  stickyMarker,
} from "../src/github/pr-comment.js";

function buildMockOctokit(
  opts: {
    existingComments?: Array<{ id: number; body?: string | null }>;
  } = {},
) {
  const listComments = vi.fn().mockResolvedValue({
    data: opts.existingComments ?? [],
  });
  const createComment = vi.fn().mockResolvedValue({ data: { id: 999 } });
  const updateComment = vi.fn().mockResolvedValue({ data: { id: 0 } });

  const octokit = {
    rest: {
      issues: { listComments, createComment, updateComment },
    },
  } as unknown as Octokit;

  return { octokit, listComments, createComment, updateComment };
}

describe("createOrUpdateStickyComment", () => {
  test("posts a new comment when no marker is found", async () => {
    const { octokit, listComments, createComment, updateComment } =
      buildMockOctokit({ existingComments: [{ id: 1, body: "unrelated" }] });

    await createOrUpdateStickyComment({
      octokit,
      owner: "acme",
      repo: "site",
      prNumber: 42,
      runId: "run-abc",
      body: "Hello world",
    });

    expect(listComments).toHaveBeenCalledWith({
      owner: "acme",
      repo: "site",
      issue_number: 42,
      per_page: 100,
    });
    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    const args = createComment.mock.calls[0]?.[0] as {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    };
    expect(args.owner).toBe("acme");
    expect(args.repo).toBe("site");
    expect(args.issue_number).toBe(42);
    expect(args.body.startsWith(stickyMarker("run-abc"))).toBe(true);
    expect(args.body).toContain("Hello world");
  });

  test("updates the existing comment when marker is present", async () => {
    const marker = stickyMarker("run-xyz");
    const { octokit, createComment, updateComment } = buildMockOctokit({
      existingComments: [
        { id: 1, body: "noise" },
        { id: 7, body: `${marker}\nOld body` },
        { id: 9, body: null },
      ],
    });

    await createOrUpdateStickyComment({
      octokit,
      owner: "acme",
      repo: "site",
      prNumber: 7,
      runId: "run-xyz",
      body: "New body",
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    const args = updateComment.mock.calls[0]?.[0] as {
      owner: string;
      repo: string;
      comment_id: number;
      body: string;
    };
    expect(args.comment_id).toBe(7);
    expect(args.body.startsWith(marker)).toBe(true);
    expect(args.body).toContain("New body");
  });

  test("ignores comments belonging to a different runId", async () => {
    const { octokit, createComment, updateComment } = buildMockOctokit({
      existingComments: [
        { id: 5, body: `${stickyMarker("run-other")}\nOther run` },
      ],
    });

    await createOrUpdateStickyComment({
      octokit,
      owner: "acme",
      repo: "site",
      prNumber: 1,
      runId: "run-mine",
      body: "Mine",
    });

    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
  });
});
