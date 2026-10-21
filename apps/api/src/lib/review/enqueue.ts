import type { Telemetry } from "@furan/telemetry";

import type { DiffQueueProducer } from "../../trpc/context.js";
import { addDiffJob, type DiffTrigger } from "../diff-enqueue.js";

/**
 * Queues a re-diff of `run` for after the request transaction commits, so the
 * worker never sees the job before the rows it re-reads (new ignore regions, a
 * threshold override, a reverted verdict) are visible.
 *
 * Forwards the run's parent branch as `parentPrBaseBranch` when it has one, so
 * the re-diff resolves baselines through the same parent_pr tier (ADR-055) as
 * the upload that first diffed it. The payload matches the SDK upload's
 * enqueue (`routes/sdk-runs.ts`); the field is omitted when null to keep the
 * wire minimal.
 *
 * The deferred sink awaits whatever the effect returns, so a failed `add`
 * surfaces after the commit exactly as it did when each caller enqueued inline.
 * `addDiffJob` counts the failure under `trigger` and rethrows it, so it still
 * surfaces.
 */
export function enqueueRunDiff(
  ctx: {
    diffQueue: DiffQueueProducer;
    telemetry: Pick<Telemetry, "metrics">;
    onCommit: (fn: () => void) => void;
  },
  run: { id: string; projectId: string; parentBranchName: string | null },
  trigger: DiffTrigger,
): void {
  ctx.onCommit(() =>
    addDiffJob(
      { diffQueue: ctx.diffQueue, registry: ctx.telemetry.metrics },
      trigger,
      {
        runId: run.id,
        projectId: run.projectId,
        ...(run.parentBranchName
          ? { parentPrBaseBranch: run.parentBranchName }
          : {}),
      },
    ),
  );
}
