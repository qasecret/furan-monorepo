import type { Octokit } from "octokit";

/**
 * Build a sticky-comment marker keyed by run ID.
 *
 * The marker is the *only* way the updater knows which comment to edit on
 * subsequent run completions — keep it stable for the lifetime of a run.
 * Multiple runs against the same PR (e.g. re-pushes) will each get their
 * own sticky comment.
 */
export const stickyMarker = (runId: string): string =>
  `<!-- furan-run-${runId} -->`;

/**
 * Idempotent sticky-comment upsert.
 *
 * - Lists the first 100 comments on the issue/PR
 * - Finds the one containing our marker (if any)
 * - PATCHes it on hit, POSTs a new one on miss
 *
 * 100 comments is the GitHub API page maximum and is plenty in practice —
 * if a PR has > 100 comments AND no prior Furan comment is in the first
 * page, we'll just post a new one. That's a degenerate case worth
 * accepting for the simplicity (no pagination loop).
 */
export async function createOrUpdateStickyComment(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  runId: string;
  body: string;
}): Promise<void> {
  const marker = stickyMarker(opts.runId);
  const fullBody = `${marker}\n${opts.body}`;
  const { data: comments } = await opts.octokit.rest.issues.listComments({
    owner: opts.owner,
    repo: opts.repo,
    issue_number: opts.prNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(marker));
  if (existing) {
    await opts.octokit.rest.issues.updateComment({
      owner: opts.owner,
      repo: opts.repo,
      comment_id: existing.id,
      body: fullBody,
    });
  } else {
    await opts.octokit.rest.issues.createComment({
      owner: opts.owner,
      repo: opts.repo,
      issue_number: opts.prNumber,
      body: fullBody,
    });
  }
}
