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
import { create } from "zustand";

import { diffViewerHref } from "@/lib/diff-viewer-href";
import { announce, reserveAnnouncement } from "@/lib/review/review-announcer";
import { loopQuery, type ReviewContext } from "@/lib/review-context";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type NextAnswer = RouterOutputs["review"]["next"];

/** The done card the viewer shows in place of a next step. */
export type ReviewCard = "batch" | "filtered" | "all";

/** What asked to move on: a decision, or J / K (and Next pending). */
type Mover = "decision" | "key";

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
  /**
   * The step on screen still needs review (the viewer's `pending` view). J
   * and K at the batch boundary then only say it is the last step (R23), and
   * the step needing review again drops the card (⌘Z, a refused decision).
   */
  stepPending: boolean;
  /**
   * The step on screen is inside the context's facets (always, without
   * facets). While it is pending it counts in the filter's count (R33).
   * Defaults to true.
   */
  stepInFilter?: boolean;
  /**
   * A decision on the step on screen is on its way to the server (its undo
   * is not). A read that started before the decision committed may show the
   * step pending again meanwhile: that is no undo (R36), so it neither drops
   * the card nor calls off the decision's move. Defaults to false.
   */
  decisionInFlight?: boolean;
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
  /**
   * A decision (or J) is waiting for `review.next` to answer (spec §5.4): the
   * Next affordance shows it is busy until the move is made or dropped.
   */
  pending: boolean;
  /**
   * The done card to show, or null. A decision brings it, and so does J or K
   * at the batch boundary on a settled step; it is dropped when the step
   * needs review again, and goes with the step it was on.
   */
  card: ReviewCard | null;
  dismissCard(): void;
  /**
   * The card's Continue (R18): the next batch's first pending step, inside the
   * filters, which the URL keeps. Only when the answer leads into another
   * batch. No cue: the card has said where it goes. The card stays up, busy,
   * until the route commits (R24).
   */
  continueToNextBatch(): void;
  /**
   * The card's Clear filter (R18): the next pending step of this batch with
   * the facets dropped (the status stays), asked when pressed. When the batch
   * has none after all, the batch card instead (All caught up when nothing is
   * left anywhere).
   */
  clearFilter(): void;
  /**
   * Continue or Clear filter is on its way (from the press until the route
   * commits, for at most 5 s): the card's buttons are busy, and pressing
   * either again does nothing.
   */
  cardBusy: boolean;
  /**
   * Leave the viewer for `href` (the card's Esc, Back to batch, Back to
   * batches). It takes its place in the order of moves: a lookup or a K
   * answer still on its way does not move the reviewer after it.
   */
  leave(href: string): void;
  /**
   * The cue of the forward move that opened this test ("Next test: ‹name› ·
   * ‹N› left in batch", with facets "· ‹M› in filter") while it is shown, for
   * about 3 s (R15); else null. Only the loop's own forward moves have one:
   * K's do not (R16). Its count is the one the header pill shows on arrival
   * (R33).
   */
  cue: string | null;
}

/** The step on screen, as the batch counts see it (R33). */
export interface StepHere {
  /** It still needs review. */
  pending: boolean;
  /** It is inside the facets (always, without facets). */
  inFilter: boolean;
}

/** A step that is not counted: settled, or being decided. */
const NOT_COUNTED: StepHere = { pending: false, inFilter: true };

/**
 * What is left in the batch, worded once for the header pill and the loop's
 * cue (R33): "‹N› left in batch", or with facets "‹N› left in batch · ‹M› in
 * filter". `review.next`'s `remaining` leaves out the step it was asked from,
 * so `here` adds it back while it still needs review: to N always, and to M
 * when it is inside the filter. Asked from the step a move leaves, with that
 * step as `here`, it is the count the reviewer sees on arrival: moving does
 * not change what is pending, and the target counts itself there.
 */
export function leftInBatchLabel(
  remaining: NextAnswer["remaining"],
  filtered: boolean,
  here: StepHere,
): string {
  if (!filtered) {
    return `${remaining.batch + (here.pending ? 1 : 0)} left in batch`;
  }
  const inBatch = remaining.batchUnfiltered + (here.pending ? 1 : 0);
  const inFilter = remaining.batch + (here.pending && here.inFilter ? 1 : 0);
  return `${inBatch} left in batch · ${inFilter} in filter`;
}

/** The viewer's own title for a run with no name. */
const UNTITLED_RUN = "Untitled run";

/** A decision waits this long for its answer; after that it is let go, silently. */
const WAIT_LIMIT_MS = 10_000;

/**
 * J and K wait this long for a move to change the step on screen; a move the
 * route never committed (a failed navigation) does not hold them for ever.
 */
const MOVE_LIMIT_MS = 5_000;

const cueText = (name: string, left: string) => `Next test: ${name} · ${left}`;

/** J or K at the batch boundary on a step that still needs review (R23). */
const LAST_IN_FILTER = "Last step to review in this filter.";
const LAST_IN_BATCH = "Last step to review in this batch.";

/** How long the visible cue stays up once its test shows it (R15). */
const CUE_MS = 3_000;

/**
 * A cue its test has not shown by then never is: the move did not land (the
 * reviewer went elsewhere first), and the test opened later must not show it.
 */
const CUE_UNSEEN_MS = 10_000;

interface LoopCue {
  text: string;
  /** The test (run) the move opened: the only one that shows it. */
  runId: string;
}

interface LoopCueState {
  /** The last forward move's cue, or null. */
  cue: LoopCue | null;
}

/**
 * The visible twin of the spoken cue (R15), for the header of the test the
 * loop moved to. A store, not state: the move replaces the page that made it,
 * and the chip is shown by the page it opens. Its 3 s start when that page
 * first shows it (the route may take a while); the next move, or leaving by
 * hand, takes it down at once.
 */
export const useLoopCue = create<LoopCueState>(() => ({ cue: null }));

/** When each cue was first on screen: the start of its 3 s. */
const cueShownAt = new WeakMap<LoopCue, number>();

function takeDown(cue: LoopCue): void {
  if (useLoopCue.getState().cue === cue) useLoopCue.setState({ cue: null });
}

function showCue(text: string, runId: string): void {
  const cue: LoopCue = { text, runId };
  useLoopCue.setState({ cue });
  setTimeout(() => {
    if (!cueShownAt.has(cue)) takeDown(cue);
  }, CUE_UNSEEN_MS);
}

/**
 * A move is being made, or the reviewer has left by hand: a cue still waiting
 * for its test's name, or still on screen, is about a place being left.
 */
function supersedeCues(): void {
  reserveAnnouncement();
  if (useLoopCue.getState().cue !== null) useLoopCue.setState({ cue: null });
}

/**
 * What a decision left on a step whose viewer a step change is replacing
 * (R37): the card it brought, or its move still waiting for an answer.
 */
interface LoopHandoff {
  /** The step it was made on, and the only one that adopts it. */
  atKey: string;
  card: ReviewCard | null;
  /** When the waiting decision started to wait; null when none waits. */
  waitingSince: number | null;
  /** When it was handed off. */
  at: number;
}

/**
 * The hand-off between the viewer a step change replaces and the one its
 * route mounts at that step (R37). A step change (the arrows, the step list)
 * shows the new step at once and asks the router for its URL; when the route
 * commits, Next mounts a new viewer, and a decision made in between was heard
 * by the old one. One slot, like the cue: the latest hand-off wins, and the
 * next viewer to mount takes it, whatever its step. Exported for tests.
 */
export const loopHandoff: { slot: LoopHandoff | null } = { slot: null };

/**
 * Takes the hand-off for the step `atKey`, at most once: the slot is emptied
 * whatever it held. A hand-off for another step, or older than a decision's
 * 10 s wait (or a waiting decision past it), is dropped.
 */
function takeHandoff(atKey: string): LoopHandoff | null {
  const h = loopHandoff.slot;
  loopHandoff.slot = null;
  if (h === null || h.atKey !== atKey) return null;
  const now = Date.now();
  if (now - h.at >= WAIT_LIMIT_MS) return null;
  if (h.waitingSince !== null && now - h.waitingSince >= WAIT_LIMIT_MS) {
    return null;
  }
  return h;
}

/**
 * The review loop (spec §3.4, §4.2): after a decision the viewer moves to the
 * next step that still needs a reviewer, on the answer of `review.next`.
 *
 *   run       the next step is in this run: replace the URL.
 *   batch     it is in another test of the batch: push it, and announce which.
 *   nextBatch this batch is done: show the batch card (or the filtered card
 *             when steps are left outside the reviewer's filters).
 *   none      nothing is left anywhere: show the all-done card. With facets
 *             set only the filter is known to be empty: the filtered card
 *             when this batch has steps outside it, else the batch card.
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
 * to wait for its answer, by the step on screen needing review again (an
 * undo, a refused decision: R30; not a stale read while a decision on it is
 * in flight: R36), and when the hook unmounts (in the viewer,
 * leaving a step by any route unmounts it). K reads the epoch when pressed
 * and a waiting decision records it when it starts to wait; either one's
 * answer is dropped if the epoch has changed since, so the latest move always
 * wins: a K answer never overrides a later J, decision or departure, and a
 * deferred decision never moves the reviewer again after K has. From a move
 * until the step on screen changes (or for at most 5 s), J and K do nothing:
 * they would be asked from the step being left. A move to the step on screen,
 * or to the one a move still on its way already goes to, is not made again.
 * Every move also takes a place in the order of announcements, so a cue still
 * waiting for its test's name is not said after a later move; leaving the
 * page by hand does the same.
 *
 * A step change shows the new step at once, and Next mounts a new viewer
 * there when its route commits. A decision made in between hands its card,
 * or its move still waiting for an answer, to that viewer, once (R37; see
 * `loopHandoff`).
 */
export function useReviewLoop({
  projectId,
  buildId,
  runId,
  checkpointId,
  context,
  enabled,
  stepPending,
  stepInFilter = true,
  decisionInFlight = false,
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
  // A decision (or J) that came before the answer: the step it waits on, the
  // epoch when it started to wait, which of the two it was, and since when
  // (its 10 s run from there, across a step-change remount too: R37).
  const [waiting, setWaiting] = useState<{
    atKey: string;
    epoch: number;
    by: Mover;
    since: number;
  } | null>(null);
  // Continue or Clear filter on its way, from the card on this step.
  const [busy, setBusy] = useState<{ atKey: string | undefined } | null>(null);
  // All three belong to the step they were made on; moving away drops them
  // for good, so coming back never brings a card or a pending move back.
  if (shown && shown.atKey !== atKey) setShown(null);
  if (waiting !== null && waiting.atKey !== atKey) setWaiting(null);
  if (busy && busy.atKey !== atKey) setBusy(null);
  // Orders the moves (see the doc above).
  const epoch = useRef(0);
  // A card is for a settled step. The step needing review again (⌘Z, a
  // refused decision) drops it, for good: settling it some other way (Mark as
  // Bug, approve pending, an override) brings none back. The change, not the
  // state: a decision brings its card before its own update has landed.
  // On the step on screen (not a move to another step that needs review), it
  // also calls off the loop's move still on its way (R30): a decision waiting
  // for its answer, Continue or Clear filter, and a K answer. The reviewer
  // took the step back to review it; nothing moves them off it.
  // Not while a decision on the step is in flight (R36): a read that started
  // before it committed shows the step pending until the refetch after it
  // lands, and the reviewer took nothing back. Nor when that decision settles
  // under such a read: the step was already reading pending, so that is no
  // change. Its undo can only come once it has settled, and does count.
  const [was, setWas] = useState({ pending: stepPending, atKey });
  if (was.pending !== stepPending || was.atKey !== atKey) {
    setWas({ pending: stepPending, atKey });
    if (stepPending && !was.pending && !decisionInFlight) {
      if (shown) setShown(null);
      if (was.atKey === atKey) {
        if (waiting !== null) setWaiting(null);
        if (busy) setBusy(null);
        epoch.current += 1;
      }
    }
  }
  // Read by answers that come back later (K's), and by a move's cue.
  const stepPendingRef = useRef(stepPending);
  stepPendingRef.current = stepPending;
  const stepInFilterRef = useRef(stepInFilter);
  stepInFilterRef.current = stepInFilter;
  const decisionInFlightRef = useRef(decisionInFlight);
  decisionInFlightRef.current = decisionInFlight;
  // What a decision left on the step, for a hand-off when this instance goes.
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  // The step this instance opened on, and the step on screen. They differ
  // after a step change whose route has not committed yet: when it does, Next
  // mounts a new viewer at the step on screen (R37).
  const openedOn = useRef(checkpointId);
  const stepOnScreen = useRef(checkpointId);
  stepOnScreen.current = checkpointId;

  // The step on screen right now, for answers that come back later. Set in a
  // layout effect, so no answer is checked against a step already replaced.
  const atKeyRef = useRef(atKey);
  // The K on its way, if any: one at a time, and a new step starts afresh.
  const prevPending = useRef<symbol | null>(null);
  // A move has been made and the route has not committed it yet: when, and
  // where to.
  const moving = useRef(false);
  const movedAt = useRef(0);
  const lastHref = useRef<string | null>(null);
  // This instance has sent the reviewer elsewhere itself (a move, or leave):
  // it hands nothing off when it goes.
  const departing = useRef(false);
  useLayoutEffect(() => {
    atKeyRef.current = atKey;
    prevPending.current = null;
    moving.current = false;
    departing.current = false;
  }, [atKey]);
  /** A move is on its way to the screen, and not given up on yet. */
  const isMoving = useCallback(
    () => moving.current && Date.now() - movedAt.current < MOVE_LIMIT_MS,
    [],
  );
  // Leaving the step by any route ends this instance: whatever is still on
  // its way (a K answer) is for a page that is gone. Left by hand (a link,
  // another step), a cue too: a move this hook made keeps its own, which is
  // for the page it opens, unless the move was given up on (5 s) and the
  // reviewer then left some other way. Development's strict mode runs this on
  // a remount as well; the page is back by the next microtask, and nothing is
  // dropped.
  // Going because the route of a step change has committed (R37), a card on
  // the step on screen, or a decision on it still waiting for its answer, is
  // handed to the viewer Next mounts there. Not when this instance opened on
  // the step on screen (the reviewer left it by hand, and coming back brings
  // nothing back), nor when it moved the reviewer itself.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const key = atKeyRef.current;
      if (
        key !== undefined &&
        !departing.current &&
        stepOnScreen.current !== openedOn.current
      ) {
        const card = shownRef.current;
        const wait = waitingRef.current;
        const handoff: LoopHandoff = {
          atKey: key,
          card: card !== null && card.atKey === key ? card.card : null,
          waitingSince:
            wait !== null && wait.atKey === key && wait.by === "decision"
              ? wait.since
              : null,
          at: Date.now(),
        };
        if (handoff.card !== null || handoff.waitingSince !== null) {
          loopHandoff.slot = handoff;
        }
      }
      epoch.current += 1;
      prevPending.current = null;
      if (!isMoving()) {
        queueMicrotask(() => {
          if (!mounted.current) supersedeCues();
        });
      }
    };
  }, [isMoving]);

  // The hand-off a step change left for this step (R37), taken the first time
  // this instance knows its step: a card, shown as the decision would have
  // shown it, or a decision waiting for its answer, which waits on here and
  // moves as it would have. Not when the step needs review again with no
  // decision on it in flight (⌘Z, a refusal came first: R30). Kept for the
  // instance's first step only, so strict mode's replayed mount applies it
  // again (recording the epoch after the replayed unmount's bump) and coming
  // back to the step later brings nothing back.
  const adopted = useRef<LoopHandoff | null | undefined>(undefined);
  useEffect(() => {
    if (atKey === undefined) return;
    if (adopted.current === undefined) adopted.current = takeHandoff(atKey);
    const handoff = adopted.current;
    if (handoff === null) return;
    if (
      handoff.atKey !== atKey ||
      (stepPendingRef.current && !decisionInFlightRef.current)
    ) {
      adopted.current = null;
      return;
    }
    const { card, waitingSince } = handoff;
    if (card !== null) setShown({ card, atKey });
    if (waitingSince !== null) {
      epoch.current += 1;
      setWaiting({
        atKey,
        epoch: epoch.current,
        by: "decision",
        since: waitingSince,
      });
    }
  }, [atKey]);

  /**
   * Say which test the reviewer has been taken to, and what is left (`left`,
   * from `leftInBatchLabel`).
   */
  const announceMove = useCallback(
    (target: { runId: string }, left: string) => {
      // Said only if no later cue was reserved by then: a name that arrives
      // after the next move's cue belongs to a place already left. What is
      // said is also shown, on the test it names (R15).
      const say = reserveAnnouncement();
      const cue = (name: string | null) => {
        const text = cueText(name ?? UNTITLED_RUN, left);
        if (say(text)) showCue(text, target.runId);
      };
      const cached = utils.runs.getById.getData({ runId: target.runId });
      if (cached) {
        cue(cached.name);
        return;
      }
      // Not loaded yet (the prefetch is still on its way): the move does not
      // wait for the name; it is said when the run arrives.
      void utils.runs.getById.fetch({ runId: target.runId }).then(
        (run) => cue(run.name),
        () => cue(null),
      );
    },
    [utils],
  );

  /**
   * Go to a step the loop found: replace the URL, or push a new entry. Not
   * made, and false, when it is the step on screen, or the step a move still
   * on its way already goes to (a decision made before that move commits):
   * the reviewer is not sent, nor told, twice. The URL carries the review
   * context, or `context` (Clear filter's, without the facets).
   */
  const goTo = useCallback(
    (
      target: NonNullable<NextAnswer["target"]>,
      how: "replace" | "push",
      context: ReviewContext = loopContext,
    ) => {
      const href = diffViewerHref(
        projectId,
        target.runId,
        target.checkpointId,
        context,
      );
      const onScreen = at
        ? diffViewerHref(projectId, at.runId, at.checkpointId, loopContext)
        : undefined;
      if (href === onScreen) return false;
      if (isMoving() && href === lastHref.current) return false;
      epoch.current += 1;
      moving.current = true;
      // The reviewer goes where the loop sends them: nothing is handed off.
      departing.current = true;
      loopHandoff.slot = null;
      movedAt.current = Date.now();
      lastHref.current = href;
      supersedeCues();
      if (how === "replace") router.replace(href);
      else router.push(href);
      return true;
    },
    [projectId, at, loopContext, isMoving, router],
  );

  /** Show a done card on the step on screen, in place of a move. */
  const showCard = useCallback(
    (card: ReviewCard) => {
      supersedeCues();
      setShown({ card, atKey });
    },
    [atKey],
  );

  /**
   * Nothing left in the batch (`nextBatch` / `none`): the card. Steps left
   * outside the filters make it the filtered one (the reviewer is done with
   * what they chose, not with the batch); and with a filter set, "nothing
   * left anywhere" is only true of the filter (R25). J and K on a step that
   * still needs review say it is the last one instead (R23): the card would
   * cover it.
   */
  const atBoundary = useCallback(
    (answer: NextAnswer, by: Mover) => {
      const outside = answer.remaining.batchUnfiltered > 0;
      const faceted = Object.keys(loopContext.facets).length > 0;
      if (by === "key" && stepPendingRef.current) {
        const text = faceted && outside ? LAST_IN_FILTER : LAST_IN_BATCH;
        supersedeCues();
        announce(text);
        showCue(text, runId);
        return;
      }
      if (answer.scope === "nextBatch") {
        showCard(outside ? "filtered" : "batch");
      } else {
        showCard(outside ? "filtered" : faceted ? "batch" : "all");
      }
    },
    [loopContext, runId, showCard],
  );

  /** Act on an answer: the table in the hook's doc. */
  const transition = useCallback(
    (answer: NextAnswer, by: Mover) => {
      epoch.current += 1;
      // A move leaves a card this step had up until the route commits (R24):
      // the new step comes without it.
      switch (answer.scope) {
        case "run":
          if (answer.target) goTo(answer.target, "replace");
          return;
        case "batch": {
          if (!answer.target) return;
          // The count the reviewer sees on arrival (R33). A decision's step is
          // no longer pending (its own update may not have rendered yet); a
          // J leaves the step on screen as it is.
          const here: StepHere =
            by === "decision"
              ? NOT_COUNTED
              : {
                  pending: stepPendingRef.current,
                  inFilter: stepInFilterRef.current,
                };
          const faceted = Object.keys(loopContext.facets).length > 0;
          if (goTo(answer.target, "push")) {
            announceMove(
              answer.target,
              leftInBatchLabel(answer.remaining, faceted, here),
            );
          }
          return;
        }
        case "nextBatch":
        case "none":
          atBoundary(answer, by);
          return;
      }
    },
    [goTo, announceMove, atBoundary, loopContext],
  );

  /** What a decision and J both do: move on the answer, or wait for it. */
  const advance = useCallback(
    (by: Mover) => {
      // After an error there is no answer coming: stay put (it is shown).
      if (!active || atKey === undefined || failed) return;
      if (settled) {
        transition(settled, by);
      } else {
        epoch.current += 1;
        setWaiting({ atKey, epoch: epoch.current, by, since: Date.now() });
      }
    },
    [active, atKey, failed, settled, transition],
  );
  const afterDecision = useCallback(() => advance("decision"), [advance]);

  // J: as a decision, unless a move is still on its way to the screen.
  const goNext = useCallback(() => {
    if (isMoving()) return;
    advance("key");
  }, [isMoving, advance]);

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
    transition(settled, waiting.by);
  }, [waiting, failed, settled, transition]);

  // ... and it is not waited for for ever.
  useEffect(() => {
    if (waiting === null) return;
    const timer = setTimeout(
      () => setWaiting(null),
      Math.max(0, waiting.since + WAIT_LIMIT_MS - Date.now()),
    );
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
      isMoving()
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
        // Backwards stays inside this batch: another batch is not "previous".
        // The move bumps the epoch, which drops a decision still waiting for
        // its forward answer. At the batch boundary, as J does (R27).
        if (answer.scope === "run" && answer.target) {
          goTo(answer.target, "replace");
        } else if (answer.scope === "batch" && answer.target) {
          goTo(answer.target, "push");
        } else if (answer.scope === "nextBatch" || answer.scope === "none") {
          atBoundary(answer, "key");
        }
      })
      .catch(() => {
        // The key does nothing; the reviewer can press it again.
      })
      .finally(() => {
        if (prevPending.current === token) prevPending.current = null;
      });
  }, [
    active,
    at,
    atKey,
    utils,
    projectId,
    loopContext,
    isMoving,
    goTo,
    atBoundary,
  ]);

  const dismissCard = useCallback(() => setShown(null), []);

  const leave = useCallback(
    (href: string) => {
      epoch.current += 1;
      departing.current = true;
      router.push(href);
    },
    [router],
  );

  // Busy until the route commits (the step changes), for at most 5 s: a move
  // the route never commits lets the buttons go again, as `goTo` does.
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(
      () => setBusy((b) => (b === busy ? null : b)),
      MOVE_LIMIT_MS,
    );
    return () => clearTimeout(timer);
  }, [busy]);

  const continueToNextBatch = useCallback(() => {
    // The answer the card shows: its target is the next batch's first pending
    // step inside the facets (R5). Through `goTo`, like every move; the card
    // stays up until the route commits (R24).
    if (busy || next?.scope !== "nextBatch" || !next.target) return;
    if (goTo(next.target, "push")) setBusy({ atKey });
  }, [busy, next, goTo, atKey]);

  // Asked when pressed, like K, from the step on screen; and like K's, its
  // answer is dropped if anything moved the reviewer meanwhile. Busy from the
  // press: a second one does not ask again.
  const clearFilter = useCallback(() => {
    if (busy || !active || !at || atKey === undefined || isMoving()) return;
    const mine = { atKey };
    setBusy(mine);
    const done = () => setBusy((b) => (b === mine ? null : b));
    const asked = epoch.current;
    utils.review.next
      .fetch({ projectId, at })
      .then((answer) => {
        if (epoch.current !== asked || atKeyRef.current !== atKey) {
          done();
          return;
        }
        // In this run the URL is replaced; in another test, pushed.
        const how =
          answer.scope === "run"
            ? "replace"
            : answer.scope === "batch"
              ? "push"
              : null;
        if (!answer.target || how === null) {
          // Nothing is left in the batch after all (a teammate took the last
          // of it): the batch is done, or everything is (no filter now). An
          // undo meanwhile has already called the lookup off (R30).
          epoch.current += 1;
          done();
          showCard(answer.scope === "none" ? "all" : "batch");
          return;
        }
        // The status stays; the facets are what is being cleared. The card
        // stays up, busy, until the route commits (R24).
        if (!goTo(answer.target, how, { ...loopContext, facets: {} })) {
          done();
          return;
        }
        // Into a test the reviewer did not pick: said, like the loop's own
        // moves (R26), with the count outside the filter: the facets are
        // gone on arrival, and this answer was asked without them.
        if (how === "push") {
          announceMove(
            answer.target,
            leftInBatchLabel(answer.remaining, false, {
              pending: stepPendingRef.current,
              inFilter: true,
            }),
          );
        }
      })
      .catch(() => {
        // The button does nothing; the reviewer can press it again.
        done();
      });
  }, [
    busy,
    active,
    at,
    atKey,
    isMoving,
    utils,
    projectId,
    loopContext,
    goTo,
    showCard,
    announceMove,
  ]);

  // The cue is shown on the test it names, not on the one the move left; its
  // 3 s run from the first time a page of that test shows it.
  const matching = useLoopCue((s) =>
    s.cue !== null && s.cue.runId === runId ? s.cue : null,
  );
  const cue = enabled ? matching : null;
  useEffect(() => {
    if (!cue) return;
    const first = cueShownAt.get(cue) ?? Date.now();
    cueShownAt.set(cue, first);
    const timer = setTimeout(
      () => takeDown(cue),
      Math.max(0, first + CUE_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [cue]);
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
    afterDecision,
    pending: waiting !== null,
    card: shown?.card ?? null,
    dismissCard,
    continueToNextBatch,
    clearFilter,
    cardBusy: busy !== null,
    leave,
    cue: cue?.text ?? null,
  };
}
