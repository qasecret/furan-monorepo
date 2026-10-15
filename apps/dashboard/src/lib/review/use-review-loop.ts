"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { diffViewerHref } from "@/lib/diff-viewer-href";
import { reserveAnnouncement } from "@/lib/review/review-announcer";
import { loopQuery, type ReviewContext } from "@/lib/review-context";
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
  /**
   * `review.next` failed. A decision made meanwhile stays put (it does not
   * wait for an answer that will not come); Task 14 shows this in the header.
   */
  error: { message: string } | null;
  /** Ask `review.next` again after an error. */
  retry(): void;
  /**
   * J: the next step that needs a reviewer. Does nothing while a move is on
   * its way to the screen.
   */
  goNext(): void;
  /** K: the previous step that needs a reviewer; the same guard as J. */
  goPrev(): void;
  /** Called when a decision is made: moves on, or shows a card when nothing is left. */
  afterDecision(): void;
  /** The done card to show, or null. */
  card: ReviewCard | null;
  dismissCard(): void;
}

/** The viewer's own title for a run with no name. */
const UNTITLED_RUN = "Untitled run";

/** A decision waits this long for its answer; after that it is let go, silently. */
const WAIT_LIMIT_MS = 10_000;

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
 * at once. It is acted on only when it is in hand: not while it is being
 * refetched (a decision invalidates it, and the fresh answer may differ: the
 * decision may have settled the step it named). Otherwise the move waits for
 * it, for at most 10 s, and is dropped if the reviewer has gone to another
 * step meanwhile or `review.next` fails. Every move goes through
 * `diffViewerHref` with the review context, so the filters are never lost.
 *
 * Moves race: the router commits a new URL only after a round trip, so the
 * props still name the old step for a while. A navigation epoch orders them.
 * It is bumped by every move or card this hook makes, by a decision that has
 * to wait for its answer, and when the hook unmounts (in the viewer, leaving a
 * step by any route unmounts it). K reads the epoch when pressed and a waiting
 * decision records it when it starts to wait; either one's answer is dropped
 * if the epoch has changed since, so the latest move always wins: a K answer
 * never overrides a later J, decision or departure, and a deferred decision
 * never moves the reviewer again after K has. From a move until the step on
 * screen changes, J and K do nothing: they would be asked from the step being
 * left. Every move also takes a place in the order of announcements, so a
 * cue still waiting for its test's name is not said after a later move.
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

  // The hook uses the status and facets of the context, and `loopQuery` is
  // exactly those; keyed on it, an equal context object from an unmemoized
  // caller does not change the callbacks below.
  const contextKey = loopQuery(context);
  const loopContext = useMemo(() => context, [contextKey]);

  // `review.next` is asked from a real step: not before the viewer has
  // resolved `_first`, nor before the batch is known.
  const at = useMemo(
    () =>
      buildId !== undefined &&
      checkpointId !== undefined &&
      checkpointId !== "_first"
        ? { buildId, runId, checkpointId }
        : undefined,
    [buildId, runId, checkpointId],
  );
  const active = enabled && at !== undefined;
  // Names the step on screen. The answer in hand always belongs to it: the
  // query key changes with `at`, and there is no placeholder data.
  const atKey = at ? `${at.buildId}/${at.runId}/${at.checkpointId}` : undefined;

  const query = trpc.review.next.useQuery(
    { projectId, ...(at ? { at } : {}), facets: loopContext.facets },
    { enabled: active },
  );
  const next = active ? query.data : undefined;
  const failed = active && query.isError;
  // The answer, when it can be acted on: not while it is being refetched
  // (after a decision invalidated it, it may be about to change), and not
  // after an error (what it knew before is not to be trusted).
  const settled =
    active && !query.isFetching && !failed ? query.data : undefined;

  const [shown, setShown] = useState<{
    card: ReviewCard;
    atKey: string | undefined;
  } | null>(null);
  // A decision (or J) that came before the answer: the step it waits on, and
  // the epoch when it started to wait.
  const [waiting, setWaiting] = useState<{
    atKey: string;
    epoch: number;
  } | null>(null);
  // Both belong to the step they were made on; moving away drops them for
  // good, so coming back never brings a card or a pending move back.
  if (shown && shown.atKey !== atKey) setShown(null);
  if (waiting !== null && waiting.atKey !== atKey) setWaiting(null);

  // Orders the moves (see the doc above).
  const epoch = useRef(0);
  // The step on screen right now, for answers that come back later. Set in a
  // layout effect, so no answer is checked against a step already replaced.
  const atKeyRef = useRef(atKey);
  // The K on its way, if any: one at a time, and a new step starts afresh.
  const prevPending = useRef<symbol | null>(null);
  // A move has been made and the route has not committed it yet.
  const moving = useRef(false);
  useLayoutEffect(() => {
    atKeyRef.current = atKey;
    prevPending.current = null;
    moving.current = false;
  }, [atKey]);
  // Leaving the step by any route ends this instance: whatever is still on
  // its way (a K answer) is for a page that is gone.
  useEffect(
    () => () => {
      epoch.current += 1;
      prevPending.current = null;
    },
    [],
  );

  /** Say which test the reviewer has been taken to. */
  const announceMove = useCallback(
    (target: { runId: string }, left: number) => {
      // Said only if no later cue was reserved by then: a name that arrives
      // after the next move's cue belongs to a place already left.
      const say = reserveAnnouncement();
      const cached = utils.runs.getById.getData({ runId: target.runId });
      if (cached) {
        say(cueText(cached.name ?? UNTITLED_RUN, left));
        return;
      }
      // Not loaded yet (the prefetch is still on its way): the move does not
      // wait for the name; it is said when the run arrives.
      void utils.runs.getById.fetch({ runId: target.runId }).then(
        (run) => say(cueText(run.name ?? UNTITLED_RUN, left)),
        () => say(cueText(UNTITLED_RUN, left)),
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
      epoch.current += 1;
      moving.current = true;
      // A cue still waiting for its name belongs to a place being left.
      reserveAnnouncement();
      const href = diffViewerHref(
        projectId,
        target.runId,
        target.checkpointId,
        loopContext,
      );
      if (how === "replace") router.replace(href);
      else router.push(href);
    },
    [projectId, loopContext, router],
  );

  /** Act on an answer: the table in the hook's doc. */
  const transition = useCallback(
    (answer: NextAnswer) => {
      epoch.current += 1;
      reserveAnnouncement();
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
    // After an error there is no answer coming: stay put (the error is shown).
    if (!active || atKey === undefined || failed) return;
    if (settled) {
      transition(settled);
    } else {
      epoch.current += 1;
      setWaiting({ atKey, epoch: epoch.current });
    }
  }, [active, atKey, failed, settled, transition]);

  // J: as a decision, unless a move is still on its way to the screen.
  const goNext = useCallback(() => {
    if (moving.current) return;
    advance();
  }, [advance]);

  // The answer a decision was waiting for has come, or will not come.
  useEffect(() => {
    if (waiting === null) return;
    if (failed) {
      setWaiting(null);
      return;
    }
    if (!settled) return;
    setWaiting(null);
    // A move made since it started to wait (K's) has already taken the
    // reviewer elsewhere: this answer is for the step they left.
    if (epoch.current !== waiting.epoch) return;
    transition(settled);
  }, [waiting, failed, settled, transition]);

  // ... and it is not waited for for ever.
  useEffect(() => {
    if (waiting === null) return;
    const timer = setTimeout(() => setWaiting(null), WAIT_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

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
  const goPrev = useCallback(() => {
    if (
      !active ||
      !at ||
      atKey === undefined ||
      prevPending.current ||
      moving.current
    ) {
      return;
    }
    // Not a move yet: a decision already waiting for its answer still moves
    // when it comes, unless this answer moves the reviewer first.
    const asked = epoch.current;
    const token = Symbol("prev");
    prevPending.current = token;
    utils.review.next
      .fetch({ projectId, at, direction: "prev", facets: loopContext.facets })
      .then((answer) => {
        // Anything that moved the reviewer since K was pressed (J, a decision,
        // a deferred decision, leaving the page) wins; so does going to
        // another step by hand.
        if (epoch.current !== asked || atKeyRef.current !== atKey) return;
        if (!answer.target) return;
        // Backwards stays inside this batch: another batch is not "previous".
        // The move bumps the epoch, which drops a decision still waiting for
        // its forward answer.
        if (answer.scope === "run") goTo(answer.target, "replace");
        else if (answer.scope === "batch") goTo(answer.target, "push");
      })
      .catch(() => {
        // The key does nothing; the reviewer can press it again.
      })
      .finally(() => {
        if (prevPending.current === token) prevPending.current = null;
      });
  }, [active, at, atKey, utils, projectId, loopContext, goTo]);

  const dismissCard = useCallback(() => setShown(null), []);
  const refetch = query.refetch;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    next,
    loading: active && query.isLoading,
    error: failed ? query.error : null,
    retry,
    goNext,
    goPrev,
    afterDecision: advance,
    card: shown?.card ?? null,
    dismissCard,
  };
}
