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
 * A step of `runId` as the cache holds it, never read for itself: a
 * neighbour `usePrefetchSteps` fetched ahead, once it is in.
 */
export function useCachedStep(
  runId: string,
  checkpointId: string | undefined,
): StepView | undefined {
  return trpc.runs.getStep.useQuery(
    { runId, checkpointId: checkpointId ?? "" },
    { ...stepOptions, enabled: false },
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
  state: StepView["review"]["state"];
  decision: { actionId: string; undo: { allowed: boolean } } | null;
  newerCapture: { buildName: string } | null;
  diffFailedAt: string | null;
}

/** The step list and the step's own read say the same of its review. */
function agree(listed: ListedStep, view: StepView): boolean {
  const { review, newerCapture, step } = view;
  return (
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
