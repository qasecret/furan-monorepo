import type { Octokit } from "octokit";

/**
 * Single canonical commit-status context for Furan. Branch protection rules
 * in dogfood repos reference this exact string — DO NOT change it without
 * coordinating a migration of all branch-protection settings.
 */
export const STATUS_CHECK_CONTEXT = "furan/baselines";

/**
 * Create or update a commit status on `sha`.
 *
 * GitHub's commit-status API is upsert-by-(sha, context): re-posting with
 * the same context overwrites the prior state. That maps cleanly to the
 * "rerun a run" flow — we just call this again with the new state.
 *
 * We use the older Statuses API (vs the newer Checks API) intentionally:
 * Statuses requires only `repo:status` scope and works for App
 * installations without a separate check-run lifecycle. T8 stays minimal;
 * a future task can upgrade to Checks if richer UI (annotations, etc.)
 * becomes worth the API surface.
 */
export async function createOrUpdateStatusCheck(opts: {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  state: "pending" | "success" | "failure";
  description: string;
  targetUrl?: string;
}): Promise<void> {
  await opts.octokit.rest.repos.createCommitStatus({
    owner: opts.owner,
    repo: opts.repo,
    sha: opts.sha,
    state: opts.state,
    context: STATUS_CHECK_CONTEXT,
    description: opts.description,
    ...(opts.targetUrl !== undefined ? { target_url: opts.targetUrl } : {}),
  });
}
