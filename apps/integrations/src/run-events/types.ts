import type { RunStatus } from "@furan/shared-types";

/**
 * Minimal `run:*:events` payload union — defined locally in the
 * integrations app because there is no canonical shared type yet.
 *
 * Source of truth today (T8 timeframe):
 * - `apps/capture-worker/src/handler.ts` publishes `capture.started` /
 *   `capture.completed`
 * - `apps/diff-worker/src/handler.ts` publishes `diff.started` /
 *   `diff.completed`
 * - `run.completed` is REFERENCED by `apps/dashboard/src/hooks/useRunEvents.ts`
 *   but has no publisher today; T8's consumer parses it anyway so the wire
 *   contract is forward-compatible when a publisher is added.
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
  | { type: "diff.started"; runId: string }
  | {
      type: "diff.completed";
      runId: string;
      passed?: boolean;
      diffPercent?: number;
      ranTiers?: string[];
      firstBaseline?: boolean;
      durationMs?: number;
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
      // Optional repo+PR context. Without these the GitHub-side updaters
      // can't act, but the event itself is still valid for other
      // subscribers (Slack, outbound webhooks in T9).
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
