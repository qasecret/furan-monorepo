"use client";

import { useEffect } from "react";

import { trpc, type RouterOutputs } from "@/lib/trpc";

/**
 * The viewer's reads of one step (spec 2026-10-27 §5): `runs.getStep` for the
 * step on screen, and the steps either side of it fetched ahead, all through
 * one react-query cache entry per step.
 */

/** One step as the viewer shows it: its row, baseline, regions and review. */
export type StepView = RouterOutputs["runs"]["getStep"];

/**
 * How long a step read stays fresh. Everything that changes a step reaches
 * its cache entry as an invalidation (a decision or its undo, a retry, the
 * run's events, an ignore-region or sensitivity save), so a step read this
 * recently is current: a neighbour fetched ahead is shown from the cache when
 * the reviewer moves to it, with no second read, while a step left longer ago
 * is read again when it is shown.
 */
export const STEP_STALE_MS = 30_000;

/**
 * The run has no such step (`NOT_FOUND`: another run's, another project's,
 * or gone), or the id is not one (`BAD_REQUEST`): asking again changes
 * nothing.
 */
export function isNoSuchStep(error: unknown): boolean {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  return code === "NOT_FOUND" || code === "BAD_REQUEST";
}

/** What every read of a step shares, so the reads share one cache entry. */
const stepOptions = {
  staleTime: STEP_STALE_MS,
  retry: (failures: number, error: unknown) =>
    !isNoSuchStep(error) && failures < 3,
};

/** One step of `runId`, read when `checkpointId` is known. */
export function useStep(runId: string, checkpointId: string | undefined) {
  return trpc.runs.getStep.useQuery(
    { runId, checkpointId: checkpointId ?? "" },
    { ...stepOptions, enabled: checkpointId !== undefined },
  );
}

/**
 * A neighbour of the step on screen, which `usePrefetchSteps` fetches ahead:
 * watched like the step on screen, so an event that makes it stale (the run's
 * events, a decision, an ignore-region or sensitivity save) reads it again at
 * once, and a move to it never shows what it was before the event.
 *
 * Watching it adds no read when it mounts: it reads a neighbour that is
 * missing or stale, but so does the prefetch beside it (same steps, same
 * `staleTime`), and react-query sends one read per step at a time, so the two
 * share it; a fresh one is read by neither. Like any watched query, a stale
 * neighbour is also read again when the window regains focus or the network
 * comes back.
 */
export function useNeighbourStep(
  runId: string,
  checkpointId: string | undefined,
): StepView | undefined {
  return trpc.runs.getStep.useQuery(
    { runId, checkpointId: checkpointId ?? "" },
    { ...stepOptions, enabled: checkpointId !== undefined },
  ).data;
}

/**
 * Fetches one step ahead of a move to it. Through react-query: a step that is
 * in the cache and fresh is not read again, and one on its way is not asked
 * for twice.
 */
export function prefetchStep(
  utils: ReturnType<typeof trpc.useUtils>,
  runId: string,
  checkpointId: string,
): void {
  void utils.runs.getStep.prefetch({ runId, checkpointId }, stepOptions);
}

/**
 * Fetches `ids` (the steps either side of the one on screen, in the rail's
 * order) ahead of a move to them, once they are known (`prefetchStep`).
 */
export function usePrefetchSteps(
  runId: string,
  ids: ReadonlyArray<string | undefined>,
): void {
  const utils = trpc.useUtils();
  const wanted = ids.filter((id): id is string => id !== undefined).join(",");
  useEffect(() => {
    if (wanted === "") return;
    for (const checkpointId of wanted.split(",")) {
      prefetchStep(utils, runId, checkpointId);
    }
  }, [utils, runId, wanted]);
}

/** What the step list says of a step's review (a `listCheckpoints` item). */
interface ListedStep {
  verdict: StepView["review"]["verdict"];
  state: StepView["review"]["state"];
  decision: { actionId: string; undo: { allowed: boolean } } | null;
  newerCapture: { buildName: string } | null;
  diffFailedAt: string | null;
}

/** The step list and the step's own read say the same of its review. */
function agree(listed: ListedStep, view: StepView): boolean {
  const { review, newerCapture, step } = view;
  return (
    listed.verdict === review.verdict &&
    listed.state === review.state &&
    (listed.decision?.actionId ?? null) ===
      (review.decision?.actionId ?? null) &&
    (listed.decision?.undo.allowed ?? null) ===
      (review.decision?.undo.allowed ?? null) &&
    (listed.newerCapture?.buildName ?? null) ===
      (newerCapture?.buildName ?? null) &&
    listed.diffFailedAt === step.diffFailedAt
  );
}

/**
 * Reads the step again when the step list, read since, says something else
 * of its review: a decision made elsewhere while the step's read was still
 * fresh (`STEP_STALE_MS`) reaches the list first, when the viewer opens.
 * Only a step read older than the list is read again, so two answers that
 * keep disagreeing do not loop.
 */
export function useStepAgreesWithList(
  runId: string,
  listed: { item: ListedStep; readAt: number } | undefined,
  step: { view: StepView; readAt: number } | undefined,
): void {
  const utils = trpc.useUtils();
  const stale =
    listed !== undefined &&
    step !== undefined &&
    listed.readAt > step.readAt &&
    !agree(listed.item, step.view);
  const checkpointId = step?.view.step.id;
  useEffect(() => {
    if (stale && checkpointId !== undefined) {
      void utils.runs.getStep.invalidate({ runId, checkpointId });
    }
  }, [stale, utils, runId, checkpointId]);
}

/** Viewers on screen, by run. */
const viewersOf = new Map<string, number>();
/** Runs no viewer shows any more, waiting out `LEAVE_GRACE_MS`. */
const leaving = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How long a run's step reads are kept as they are after its last viewer
 * goes. The route remounts the viewer on every step, in the same commit or
 * just after: a remount on another step of the run is no leaving.
 */
const LEAVE_GRACE_MS = 1_000;

/**
 * For tests only: forgets every viewer and cancels every pending leave, so a
 * leave timer a test started (by unmounting a viewer) never fires into the
 * next test, or into a mocked client that test has torn down. Call it after
 * the test's viewers are unmounted.
 */
export function resetStepsLeftForTests(): void {
  for (const timer of leaving.values()) clearTimeout(timer);
  leaving.clear();
  viewersOf.clear();
}

/**
 * Marks the run's step reads stale once no viewer shows the run any more.
 * Away from it, its events reach no viewer; a step read kept fresh for
 * `STEP_STALE_MS` could miss a re-diff (its regions, its numbers) made
 * meanwhile, so coming back reads the steps again. Nothing is read now.
 */
export function useStepsStaleWhenLeft(runId: string): void {
  const utils = trpc.useUtils();
  useEffect(() => {
    clearTimeout(leaving.get(runId));
    leaving.delete(runId);
    viewersOf.set(runId, (viewersOf.get(runId) ?? 0) + 1);
    return () => {
      const left = (viewersOf.get(runId) ?? 1) - 1;
      if (left > 0) {
        viewersOf.set(runId, left);
        return;
      }
      viewersOf.delete(runId);
      leaving.set(
        runId,
        setTimeout(() => {
          leaving.delete(runId);
          void utils.runs.getStep.invalidate(
            { runId },
            { refetchType: "none" },
          );
        }, LEAVE_GRACE_MS),
      );
    };
  }, [utils, runId]);
}
