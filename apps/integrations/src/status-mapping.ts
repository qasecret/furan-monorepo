import type { RunStatus } from "@furan/shared-types";

/**
 * Single source of truth for translating Furan's 7-value `run_status`
 * enum into outbound notification surfaces:
 *   - GitHub commit-status `state` (4 values)
 *   - PR sticky-comment emoji + description
 *   - Slack Block Kit emoji + colour
 *
 * Spec: furan-design/specs/2026-05-19-run-status-enum-design.md §3.4.
 *
 * Two policy decisions are load-bearing:
 *   1. `unresolved` → GitHub `failure` (NOT `pending`) so the PR is
 *      blocked from merging until a reviewer acts. Mapping it to
 *      `pending` would silently let unreviewed diffs slip through.
 *   2. `aborted` → GitHub `error` (NOT `failure`). `error` renders
 *      distinctly in GitHub UI and operators read it as "infra-side,
 *      not test-side". `empty` stays `failure` because it's user-side
 *      (SDK was opened but never called `check`).
 */

export type GitHubStatusState = "pending" | "success" | "failure" | "error";

export type StatusPresentation = {
  githubState: GitHubStatusState;
  description: string;
  emoji: string;
};

const STATUS_PRESENTATION: Record<RunStatus, StatusPresentation> = {
  running: {
    githubState: "pending",
    description: "Furan: running…",
    emoji: "🔵",
  },
  new: {
    githubState: "success",
    description: "Furan: new test — baseline created",
    emoji: "⚪",
  },
  passed: {
    githubState: "success",
    description: "Furan: no visual changes",
    emoji: "🟢",
  },
  unresolved: {
    githubState: "failure",
    description: "Furan: visual differences — review required",
    emoji: "🟡",
  },
  failed: {
    githubState: "failure",
    description: "Furan: visual differences rejected",
    emoji: "🔴",
  },
  aborted: {
    githubState: "error",
    description: "Furan: run aborted — check worker logs",
    emoji: "⚠️",
  },
  empty: {
    githubState: "failure",
    description: "Furan: no checks recorded — verify SDK integration",
    emoji: "⚪",
  },
};

/** Look up the GitHub state + description + emoji for a Furan run status. */
export function presentationFor(status: RunStatus): StatusPresentation {
  return STATUS_PRESENTATION[status];
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "new",
  "passed",
  "unresolved",
  "failed",
  "aborted",
  "empty",
]);

/**
 * True for every status except `running`. Used by the Slack notifier to
 * skip non-terminal events: under the new 7-value taxonomy `running` is
 * no longer a terminal state, and firing a Slack message for it would
 * spam channels with mid-flight noise.
 */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
