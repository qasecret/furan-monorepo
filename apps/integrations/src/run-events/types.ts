import type { RunStatus } from "@furan/shared-types";

/**
 * Minimal `run:*:events` payload union — defined locally in the
 * integrations app because there is no canonical shared type yet.
 *
 * Source of truth today:
 * - `apps/capture-worker/src/handler.ts` publishes `capture.started` /
 *   `capture.completed`
 * - `apps/diff-worker/src/step-events.ts` publishes, per diffed step,
 *   `run.checkpoint_diffed`, and `run.completed` only when the diff moves the
 *   run's status (it no longer publishes `diff.started` / `diff.completed`)
 * - `run.completed` is what this app's consumers act on
 *
 * Reconcile to a packages/shared-types definition when one is introduced.
 */
export type RunEvent =
  | {
      type: "capture.started";
      runId: string;
      viewport?: unknown;
      browser?: string;
    }
  | {
      type: "capture.completed";
      runId: string;
      imageKey?: string;
      durationMs?: number;
    }
  | {
      type: "run.checkpoint_diffed";
      runId: string;
      screenshotId: string;
      verdict: string;
      failed: boolean;
    }
  | {
      type: "run.completed";
      runId: string;
      projectId?: string;
      // 7-value Furan `run_status` enum — see
      // `packages/shared-types/src/run-status.ts`. Publishers may also
      // emit legacy `"passed" | "failed"` for a transitional window; the
      // consumer treats any non-RunStatus value as unknown.
      status?: RunStatus;
      numChanges?: number;
      dashboardUrl?: string;
      // T9: branch + diff% so outbound webhooks (Slack notifier) can
      // render context without re-querying test_runs.
      branchName?: string;
      diffPercent?: number;
      // Optional repo+PR context. No publisher sets these today: the GitHub
      // handler resolves them from the run's row (`test_runs`) and the
      // project's installation link. When an event does carry them they win.
      // The event is valid without them for other subscribers (Slack,
      // outbound webhooks in T9).
      repoOwner?: string;
      repoName?: string;
      prNumber?: number;
      sha?: string;
      installationId?: number;
    }
  | { type: string; runId?: string; [key: string]: unknown };

export function parseRunEvent(raw: string): RunEvent | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (
      v !== null &&
      typeof v === "object" &&
      "type" in v &&
      typeof (v as { type: unknown }).type === "string"
    ) {
      return v as RunEvent;
    }
    return null;
  } catch {
    return null;
  }
}
