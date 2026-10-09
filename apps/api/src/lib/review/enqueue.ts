import type { DiffQueueProducer } from "../../trpc/context.js";

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
 */
export function enqueueRunDiff(
  ctx: { diffQueue: DiffQueueProducer; onCommit: (fn: () => void) => void },
  run: { id: string; projectId: string; parentBranchName: string | null },
): void {
  ctx.onCommit(() =>
    ctx.diffQueue.add("diff", {
      runId: run.id,
      projectId: run.projectId,
      ...(run.parentBranchName
        ? { parentPrBaseBranch: run.parentBranchName }
        : {}),
    }),
  );
}
