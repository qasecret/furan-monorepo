"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { diffViewerHref } from "@/lib/diff-viewer-href";
import { announce } from "@/lib/review/review-announcer";
import type { ReviewContext } from "@/lib/review-context";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type NextAnswer = RouterOutputs["review"]["next"];

/** The done card the viewer shows in place of a next step. */
export type ReviewCard = "batch" | "filtered" | "all";

export interface UseReviewLoopArgs {
  projectId: string;
  /** The batch the run belongs to; unknown until the run has loaded. */
  buildId: string | undefined;
  runId: string;
  /** The step on screen; `_first` or undefined until it has resolved. */
  checkpointId: string | undefined;
  /** The status and facets the reviewer filtered by; they travel with every move. */
  context: ReviewContext;
  /** Off for a reader who may not review (`review.next` refuses a guest). */
  enabled: boolean;
}

export interface ReviewLoop {
  /** Where the loop goes from this step (spec §4.2); undefined until it is known. */
  next: NextAnswer | undefined;
  loading: boolean;
  /** J: the next step that needs a reviewer. */
  goNext(): void;
  /** K: the previous step that needs a reviewer. */
  goPrev(): void;
  /** Called when a decision is made: moves on, or shows a card when nothing is left. */
  afterDecision(): void;
  /** The done card to show, or null. */
  card: ReviewCard | null;
  dismissCard(): void;
}

/** The viewer's own title for a run with no name. */
const UNTITLED_RUN = "Untitled run";

const cueText = (name: string, left: number) =>
  `Next test: ${name} · ${left} left in batch`;

/**
 * The review loop (spec §3.4, §4.2): after a decision the viewer moves to the
 * next step that still needs a reviewer, on the answer of `review.next`.
 *
 *   run       the next step is in this run: replace the URL.
 *   batch     it is in another test of the batch: push it, and announce which.
 *   nextBatch this batch is done: show the batch card (or the filtered card
 *             when steps are left outside the reviewer's filters).
 *   none      nothing is left anywhere: show the all-done card.
 *
 * The answer is fetched ahead, for the step on screen, so a decision can move
 * at once; if it has not arrived yet, the move waits for it, and is dropped
 * if the reviewer has gone to another step meanwhile. Every move goes through
 * `diffViewerHref` with the review context, so the filters are never lost.
 */
export function useReviewLoop({
  projectId,
  buildId,
  runId,
  checkpointId,
  context,
  enabled,
}: UseReviewLoopArgs): ReviewLoop {
  const router = useRouter();
  const utils = trpc.useUtils();

  // `review.next` is asked from a real step: not before the viewer has
  // resolved `_first`, nor before the batch is known.
  const at =
    buildId !== undefined &&
    checkpointId !== undefined &&
    checkpointId !== "_first"
      ? { buildId, runId, checkpointId }
      : undefined;
  const active = enabled && at !== undefined;
  // Names the step on screen. The answer in hand always belongs to it: the
  // query key changes with `at`, and there is no placeholder data.
  const atKey = at ? `${at.buildId}/${at.runId}/${at.checkpointId}` : undefined;

  const query = trpc.review.next.useQuery(
    { projectId, ...(at ? { at } : {}), facets: context.facets },
    { enabled: active },
  );
  const next = active ? query.data : undefined;

  const [shown, setShown] = useState<{
    card: ReviewCard;
    atKey: string | undefined;
  } | null>(null);
  // A decision (or J) that came before the answer: the step it waits on.
  const [waiting, setWaiting] = useState<string | null>(null);
  // Both belong to the step they were made on; moving away drops them for
  // good, so coming back never brings a card or a pending move back.
  if (shown && shown.atKey !== atKey) setShown(null);
  if (waiting !== null && waiting !== atKey) setWaiting(null);

  // The step on screen right now, for answers that come back later.
  const atKeyRef = useRef(atKey);
  useEffect(() => {
    atKeyRef.current = atKey;
  }, [atKey]);

  /** Say which test the reviewer has been taken to. */
  const announceMove = useCallback(
    (target: { runId: string }, left: number) => {
      const cached = utils.runs.getById.getData({ runId: target.runId });
      if (cached) {
        announce(cueText(cached.name ?? UNTITLED_RUN, left));
        return;
      }
      // Not loaded yet (the prefetch is still on its way): the move does not
      // wait for the name; it is said when the run arrives.
      void utils.runs.getById.fetch({ runId: target.runId }).then(
        (run) => announce(cueText(run.name ?? UNTITLED_RUN, left)),
        () => announce(cueText(UNTITLED_RUN, left)),
      );
    },
    [utils],
  );

  /** Go to a step the loop found: replace the URL, or push a new entry. */
  const goTo = useCallback(
    (
      target: NonNullable<NextAnswer["target"]>,
      how: "replace" | "push",
    ): void => {
      const href = diffViewerHref(
        projectId,
        target.runId,
        target.checkpointId,
        context,
      );
      if (how === "replace") router.replace(href);
      else router.push(href);
    },
    [projectId, context, router],
  );

  /** Act on an answer: the table in the hook's doc. */
  const transition = useCallback(
    (answer: NextAnswer) => {
      switch (answer.scope) {
        case "run":
          if (answer.target) goTo(answer.target, "replace");
          return;
        case "batch":
          if (!answer.target) return;
          goTo(answer.target, "push");
          announceMove(answer.target, answer.remaining.batch);
          return;
        case "nextBatch":
          setShown({
            card: answer.remaining.batchUnfiltered > 0 ? "filtered" : "batch",
            atKey,
          });
          return;
        case "none":
          setShown({ card: "all", atKey });
          return;
      }
    },
    [goTo, announceMove, atKey],
  );

  /** What a decision and J both do: move on the answer, or wait for it. */
  const advance = useCallback(() => {
    if (!active || atKey === undefined) return;
    if (next) transition(next);
    else setWaiting(atKey);
  }, [active, atKey, next, transition]);

  // The answer a decision was waiting for has come.
  useEffect(() => {
    if (waiting === null || !next) return;
    setWaiting(null);
    transition(next);
  }, [waiting, next, transition]);

  // Warm the target's run so the move shows it at once. The run on screen is
  // already loaded and kept fresh by the viewer; refetching it is waste.
  const targetRunId = next?.target?.runId;
  useEffect(() => {
    if (!targetRunId || targetRunId === runId) return;
    void utils.runs.getById.prefetch({ runId: targetRunId });
    void utils.runs.listCheckpoints.prefetch({ runId: targetRunId });
  }, [targetRunId, runId, utils]);

  // K asks when it is pressed, not ahead: one more query per step, for a key
  // that is pressed rarely. At most one is on its way at a time.
  const prevInFlight = useRef(false);
  const goPrev = useCallback(() => {
    if (!active || !at || atKey === undefined || prevInFlight.current) return;
    prevInFlight.current = true;
    utils.review.next
      .fetch({ projectId, at, direction: "prev", facets: context.facets })
      .then((answer) => {
        // The reviewer went elsewhere while it was on its way.
        if (atKeyRef.current !== atKey || !answer.target) return;
        // Backwards stays inside this batch: another batch is not "previous".
        if (answer.scope === "run") goTo(answer.target, "replace");
        else if (answer.scope === "batch") goTo(answer.target, "push");
      })
      .catch(() => {
        // The key does nothing; the reviewer can press it again.
      })
      .finally(() => {
        prevInFlight.current = false;
      });
  }, [active, at, atKey, utils, projectId, context.facets, goTo]);

  const dismissCard = useCallback(() => setShown(null), []);

  return {
    next,
    loading: active && query.isLoading,
    goNext: advance,
    goPrev,
    afterDecision: advance,
    card: shown?.card ?? null,
    dismissCard,
  };
}
