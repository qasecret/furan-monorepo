"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ApprovalBar } from "./ApprovalBar";
import { BaselineSourceBadge } from "./BaselineSourceBadge";
import { BatchDoneCard } from "./BatchDoneCard";
import { summarizeCheckpoints } from "./checkpoint-nav";
import type { ViewerMode } from "./comparison-modes";
import { ContextualHeader, type HeaderLoop } from "./ContextualHeader";
import { EmptyRunCard } from "./EmptyRunCard";
import { GroupApprovalCallout } from "./GroupApprovalCallout";
import {
  IgnoreRegionListPanel,
  useIgnoreRegionsInView,
} from "./IgnoreRegionListPanel";
import { useImageSet, type ImageSetRequest } from "./image-set";
import { InfoRail } from "./InfoRail";
import type { DiffRegion } from "./layers/regionTypes";
import { isPixelDiffRegion } from "./region-visibility";
import { useReviewActions } from "./review-actions";
import { SizeChip } from "./SizeChip";
import { findSmallestContainingElement } from "./snap-to-element";
import { StaleStepCallout } from "./StaleStepCallout";
import { stepDiffKey } from "./step-diff-key";
import { stepNumber } from "./step-number";
import { TestInfoSidebar } from "./TestInfoSidebar";
import {
  isNoSuchStep,
  useNeighbourStep,
  usePrefetchSteps,
  useStep,
  useStepsStaleWhenLeft,
  type StepView,
} from "./use-viewer-step";
import { useDiffStepper } from "./useDiffStepper";
import { useDiffViewerShortcuts } from "./useDiffViewerShortcuts";
import { useElementMap } from "./useElementMap";
import { useReducedMotion } from "./useReducedMotion";
import { useViewerStore } from "./useViewerStore";
import { useViewState } from "./view-state";
import { useUrlView, useViewerMode, ViewerModeProvider } from "./viewer-mode";
import { useViewerPrefs } from "./viewer-prefs";
import { ViewerLinkProvider } from "./ViewerLink";
import { ViewerStage } from "./ViewerStage";
import { ViewerToolbar } from "./ViewerToolbar";
import { ViewportSwitcher } from "./ViewportSwitcher";

import { useRunEvents, type RunEvent } from "@/hooks/useRunEvents";
import {
  bindingKey,
  formatKeyLabel,
  liveBindings,
  lowerFirst,
} from "@/lib/commands/keys";
import { usePlatform } from "@/lib/commands/platform";
import { useSingleKeyShortcuts } from "@/lib/commands/prefs";
import {
  commandLabel,
  useCommandKeys,
  useRegisteredCommands,
} from "@/lib/commands/registry";
import { diffErrorCode } from "@/lib/diff-error-copy";
import { diffViewerHref } from "@/lib/diff-viewer-href";
import { formatDuration } from "@/lib/format";
import { leftInBatchLabel, useReviewLoop } from "@/lib/review/use-review-loop";
import { useIsDecisionInFlight } from "@/lib/review/use-review-mutations";
import { useUndoStore } from "@/lib/review/use-undo-store";
import {
  batchHref,
  DEFAULT_REVIEW_STATUS,
  serializeReviewContext,
  type ReviewContext,
  type StepFacets,
} from "@/lib/review-context";
import { trpc } from "@/lib/trpc";
import { useRetryDiff } from "@/lib/use-retry-diff";

interface Props {
  runId: string;
  /** @deprecated use initialCheckpointId + projectId. Kept for legacy diffs route compat. */
  diffId?: string;
  /** ADR-038: project id for building canonical checkpoint URLs. */
  projectId?: string;
  /** ADR-038: checkpoint id to display initially; "_first" means use the first checkpoint. */
  initialCheckpointId?: string;
  /**
   * What the reviewer was looking at when the viewer opened (status chip and
   * environment facets), parsed from the page's URL. Every link the viewer
   * makes carries it, and the review loop walks inside it.
   */
  reviewContext?: ReviewContext;
  /**
   * The URL's comparison mode (spec §6.3), parsed by the page; null or
   * absent when the URL names none. It outranks the stored preference, and
   * every link the viewer makes carries it. The viewer reads the URL's view
   * from `useSearchParams` (R31, `useUrlView`); this parse holds only while
   * the URL names none. A mode change writes the history and renders no
   * page, so the page never sends it again.
   */
  view?: ViewerMode | null;
  /**
   * The viewer may decide: the server's answer for the request's role
   * (R14), so the first paint already has, or has not, the decision
   * buttons. False: the step and its decision read-only, with no Approve,
   * Reject, Mark as Bug, group approval, undo or override.
   */
  canReview: boolean;
  /**
   * Whose viewer preferences to read and store (spec §6.1), from the
   * server's session. Null: the defaults, held in memory for the visit. A
   * user id that goes to null while this viewer is open is ignored (a
   * session lookup that failed on a later server render).
   */
  userId: string | null;
}

/** A viewer opened without a review context: the default chip, no facets. */
const NO_REVIEW_CONTEXT: ReviewContext = {
  status: DEFAULT_REVIEW_STATUS,
  facets: {},
};

/**
 * The step is inside every facet the reviewer set (always, with none set): a
 * pending step outside them is in the batch's count but not the filter's.
 */
function inFacets(
  step: Partial<Record<keyof StepFacets, string | null>> | undefined,
  facets: StepFacets,
): boolean {
  if (!step) return true;
  return (Object.keys(facets) as Array<keyof StepFacets>).every(
    (k) => facets[k] === undefined || step[k] === facets[k],
  );
}

export function DiffViewer({
  runId,
  diffId,
  projectId,
  initialCheckpointId,
  reviewContext,
  view: pageView = null,
  canReview,
  userId,
}: Props) {
  // The user's preferences, read before anything here renders, so the first
  // paint is already their mode and the canvas never mounts in a mode it then
  // leaves. `hydrate` reads once per user (the viewer remounts on every step
  // and the store outlives it), so from the second render on it does nothing.
  // With no user it holds the defaults in memory, never an earlier user's.
  // Within this viewer a user doesn't become no user: a later server render
  // whose session lookup failed would otherwise swap the rail, the opacity
  // and the rest to the defaults mid-review. A new viewer (a step, a visit)
  // takes the page's answer as it is.
  const viewerUser = useRef(userId);
  if (userId !== null) viewerUser.current = userId;
  useViewerPrefs.getState().hydrate(viewerUser.current);
  const router = useRouter();
  const utils = trpc.useUtils();
  const context = reviewContext ?? NO_REVIEW_CONTEXT;

  // ADR-038: checkpoint selection state
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string>(
    initialCheckpointId ?? diffId ?? "_first",
  );

  // ADR-038: fetch the checkpoint list for the rail
  const checkpointsQuery = trpc.runs.listCheckpoints.useQuery({ runId });
  const railItems = checkpointsQuery.data?.items;

  // The run header (spec 2026-10-27 §5): the run's own fields and its build's
  // runner (`runByName`), for the INFO sidebar. One step at a time is read on
  // its own, below.
  const { data, isLoading, error } = trpc.runs.getById.useQuery({ runId });
  // The run's diff % is its worst step's: the step on screen shows its own
  // (spec §9), and the run's only for a step from before per-step diffs.
  const runDiffPercent = data?.diffPercent ?? null;

  // ADR-038: map checkpoint items to CheckpointSummary[] for step navigation.
  // `state` is the review state (new / passed / unresolved / approved /
  // rejected), null until the step has been diffed.
  const checkpointSummaries = useMemo(
    () => summarizeCheckpoints(railItems ?? []),
    [railItems],
  );
  // Sibling fetch for project settings the viewer needs (currently
  // `dynamicTextEnabled`, which gates the kind selector + PatternEditor).
  // Enabled only after `data` lands so we don't fire with an empty id.
  const projectQuery = trpc.projects.getById.useQuery(
    { projectId: data?.projectId ?? "" },
    { enabled: !!data?.projectId },
  );
  const project = projectQuery.data;

  // `_first` is the placeholder before the checkpoint list resolves.
  const activeCheckpointId =
    selectedCheckpointId !== "_first" ? selectedCheckpointId : undefined;
  // The step on screen in the checkpoint list: its facets, label and review
  // state until its own read is in.
  const stepItem = railItems?.find((c) => c.id === activeCheckpointId);

  // The step on screen, read on its own (`runs.getStep`): its row, the
  // baseline it is compared against, its regions and its review. The steps
  // either side of it in the rail are fetched ahead (below), so moving to
  // one shows it from the cache.
  const selectedStep = useStep(runId, activeCheckpointId);
  const stepView: StepView | undefined = selectedStep.data;
  // An id the run has no step for (a stale or foreign link): the rail's first
  // step is shown in its place, read-only (no review, no Save), as the viewer
  // always has.
  const noSuchStep = isNoSuchStep(selectedStep.error);
  const firstStepId = railItems?.[0]?.id;
  const fallbackStep = useStep(
    runId,
    noSuchStep && firstStepId !== activeCheckpointId ? firstStepId : undefined,
  );
  const shownStep: StepView | undefined =
    stepView ?? (noSuchStep ? fallbackStep.data : undefined);
  const candidateScreenshot = shownStep?.step ?? null;
  // A read that failed for another reason (the network, the server), with no
  // step to show: said like the header's.
  const stepError =
    shownStep === undefined && !noSuchStep ? selectedStep.error : null;
  // Still on its way: the first step (`_first`, the rail), the step, or the
  // step shown in its place. A step from before steps kept their own diff
  // images waits for the rail too: whether it may borrow the run's image (a
  // run of one step) is the rail's count to say, and until then Diff would
  // say "No pixel changes" for want of an image.
  const legacyDiffUnknown =
    shownStep !== undefined &&
    shownStep.step.diffGeneration === 0 &&
    shownStep.step.diffImageKey === null &&
    railItems === undefined;
  const stepLoading =
    activeCheckpointId === undefined
      ? checkpointsQuery.isLoading
      : (shownStep === undefined &&
          (selectedStep.isLoading ||
            (noSuchStep &&
              (checkpointsQuery.isLoading || fallbackStep.isLoading)))) ||
        (legacyDiffUnknown && checkpointsQuery.isLoading);

  // The context is the SELECTED step's (the one Save writes to), not the
  // displayed candidate's, which may stand in for an id the run lacks. Its
  // saved regions come only from its own read: never another step's, and
  // Save waits until it is in (`stepContextLoaded`).
  const stepContextLoaded = stepView !== undefined;
  const currentContext = stepView
    ? stepView.baselineContext
    : {
        baselineScreenshot:
          shownStep?.baselineContext.baselineScreenshot ?? null,
        baselineSource: shownStep?.baselineContext.baselineSource ?? null,
        variationIgnoreAreas: null,
      };

  const baselineScreenshot = currentContext.baselineScreenshot;
  // Without a baseline (a new test) only side by side is available (R2).
  const hasBaseline = (baselineScreenshot?.imageKey ?? null) !== null;

  // The comparison mode (spec §6.3): the editor's override, the URL's
  // `?view`, then the preference, and side by side where the step has no
  // baseline (R2). Every part of the viewer reads this one mode, and every
  // link the viewer makes carries the URL's view, read from
  // `useSearchParams` (R31). A mode change writes the URL of the step on
  // screen to the history, with no navigation, or goes with the step
  // change's own when ←/→ showed the step before its route committed; while
  // the review loop is on its way to another step, that move takes the mode
  // instead (R20; the loop is set up below), and so does a link's navigation
  // (R22). The ignore-region editor's override (R3) is the step's: a step
  // change clears it.
  const retargetLoopMove = useRef<(view: ViewerMode) => boolean>(() => false);
  const urlView = useUrlView(pageView);
  const viewerMode = useViewerMode({
    urlView,
    hasBaseline,
    ...(activeCheckpointId ? { step: activeCheckpointId } : {}),
    ...(projectId && activeCheckpointId
      ? { path: diffViewerHref(projectId, runId, activeCheckpointId) }
      : {}),
    retarget: (view) => retargetLoopMove.current(view),
  });
  const viewerModeContext = useMemo(
    () => ({
      view: viewerMode.view,
      setMode: viewerMode.setMode,
      available: viewerMode.available,
    }),
    [viewerMode.view, viewerMode.setMode, viewerMode.available],
  );

  // ADR-038: resolve "_first" sentinel to the real first checkpoint id
  useEffect(() => {
    if (
      selectedCheckpointId === "_first" &&
      checkpointsQuery.data?.items?.length
    ) {
      const firstId = checkpointsQuery.data.items[0]?.id;
      if (firstId) {
        setSelectedCheckpointId(firstId);
        if (projectId) {
          // The review context and the mode stay in the URL: a reload keeps
          // the scope and the mode.
          router.replace(
            diffViewerHref(projectId, runId, firstId, context, viewerMode.view),
          );
        }
      }
    }
  }, [
    selectedCheckpointId,
    checkpointsQuery.data,
    projectId,
    runId,
    router,
    context,
    viewerMode.view,
  ]);

  // ADR-038: sync URL when user navigates between checkpoints, keeping the
  // review context and the comparison mode.
  const handleCheckpointSelect = useCallback(
    (id: string) => {
      setSelectedCheckpointId(id);
      if (projectId) {
        router.replace(
          diffViewerHref(projectId, runId, id, context, viewerMode.view),
        );
      }
    },
    [projectId, runId, router, context, viewerMode.view],
  );

  // One set of review actions shared by the <ApprovalBar> buttons and the
  // A / R keyboard shortcuts, so a keypress always takes the button's path:
  // per-checkpoint decision, the step-state and run gates, unsaved ignore
  // regions folded in, the older-capture question, and the move to the next
  // pending step (the loop; Mark as Bug does not move). The loop is set up
  // below, from the step's view; a decision reaches it when it is made. A
  // decision says where its step is, in this review context, so its undo can
  // offer to come back here.
  const runProjectId = data?.projectId;
  const review = useReviewActions({
    runId,
    checkpointId: activeCheckpointId,
    status: data?.status,
    onResolved: () => loop.afterDecision(),
    ...(runProjectId
      ? {
          stepHref: (id: string) =>
            diffViewerHref(runProjectId, runId, id, context),
        }
      : {}),
  });

  // The review loop (spec §5.4), asked from the step on screen once `_first`
  // has resolved. Off until the run has loaded, for a run that failed to load
  // (a deleted run, another project's), and for a run with no batch to walk:
  // no Next pending, no J / K, and no `review.next` call. A run that may not
  // take decisions (overridden, not reviewable) still navigates; only
  // deciding is off.
  const loopOn = Boolean(data?.buildId) && !error;
  // The step on screen, for the batch counts (R33): while it needs review it
  // counts in what is left, and in the filter's count if it is inside it.
  const stepHere = {
    pending: review.view === "pending",
    inFilter: inFacets(stepItem, context.facets),
  };
  // A decision on this step still on its way: a read meanwhile that shows the
  // step pending again predates its commit, and is no undo (R36).
  const decisionInFlight = useIsDecisionInFlight(activeCheckpointId);
  const retryDiff = useRetryDiff(runId);
  const loop = useReviewLoop({
    projectId: data?.projectId ?? "",
    buildId: data?.buildId || undefined,
    runId,
    checkpointId: activeCheckpointId,
    context,
    view: viewerMode.view,
    enabled: loopOn,
    stepPending: stepHere.pending,
    stepInFilter: stepHere.inFilter,
    decisionInFlight,
  });
  retargetLoopMove.current = loop.retarget;
  const undoCount = useUndoStore((s) => s.stack.length);
  // The done card (spec §5.4) takes the canvas's place once the step on
  // screen is settled: not while a decision waits for its answer, and not
  // while the step needs review (the decision's own update lands just after
  // it; the loop drops the card if the step needs review again, R19).
  const card =
    loop.card !== null && !loop.pending && review.view !== "pending"
      ? loop.card
      : null;

  // T11: SSE — the worker's events reach the viewer's reads: the run header
  // (its status) and the steps read on their own, the one on screen and the
  // neighbours fetched ahead (their regions, numbers, verdict). A step
  // settling (its result, or its diff failing for good) also moves the step
  // list, which holds each step's review state and failure: a retried step
  // leaves "being diffed" only through it.
  const onSseEvent = useCallback(
    (e: RunEvent) => {
      if (
        e.type === "run.checkpoint_diffed" ||
        e.type === "capture.completed" ||
        e.type === "run.completed"
      ) {
        void utils.runs.getById.invalidate({ runId });
      }
      if (e.type === "run.checkpoint_diffed") {
        void utils.runs.listCheckpoints.invalidate({ runId });
        // The step that settled.
        const checkpointId = (e as { screenshotId?: unknown }).screenshotId;
        void utils.runs.getStep.invalidate(
          typeof checkpointId === "string"
            ? { runId, checkpointId }
            : { runId },
        );
      } else if (e.type === "capture.completed" || e.type === "run.completed") {
        void utils.runs.getStep.invalidate({ runId });
      }
    },
    [utils, runId],
  );
  useRunEvents(runId, onSseEvent);

  // ADR-031: hydrate the ignore-region editor's saved slices from the
  // step's variation (its read's baseline context). The run has no saved
  // regions of its own (ADR-038). The store's hydrateSavedIgnoreAreas
  // preserves drafts + markedForDeletion when unsaved changes exist
  // (guards against silent loss on react-query refetch / SSE refresh).
  const hydrateSavedIgnoreAreas = useViewerStore(
    (s) => s.hydrateSavedIgnoreAreas,
  );

  useEffect(() => {
    // Server payload may predate the paddingPx column (legacy rows have
    // no paddingPx); hydrateSavedIgnoreAreas applies `?? 0` so we widen
    // the cast and let the store normalize.
    const variationRegions = (currentContext.variationIgnoreAreas ??
      []) as Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      viewport: string;
      paddingPx?: number;
      kind?: "ignore" | "dynamic-text";
      pattern?: string;
    }>;
    hydrateSavedIgnoreAreas(
      [],
      variationRegions.map((r) => ({
        ...r,
        paddingPx: r.paddingPx ?? 0,
        kind: r.kind ?? "ignore",
      })),
    );
  }, [currentContext.variationIgnoreAreas, hydrateSavedIgnoreAreas]);

  // F-a/3: lazily fetch the candidate's element-map sidecar when in
  // ignore-edit mode AND the screenshot row has a key. Old runs that
  // predate PR #61 carry `elementMapKey === null`; the hook treats
  // null as "idle" so the proxy is never hit.
  const draftIgnoreAreas = useViewerStore((s) => s.draftIgnoreAreas);
  const pendingSnaps = useViewerStore((s) => s.pendingSnaps);
  const proposePendingSnap = useViewerStore((s) => s.proposePendingSnap);
  // Phase 1.4: the ignore-region list's delete wiring. Reads here so they
  // sit alongside the other ignore-editor selectors (the list is the info
  // rail's content while the editor is open, below).
  const activeViewport = useViewerStore((s) => s.viewport);
  // What the rail's strip counts in the editor: the list's own regions.
  const ignoreRegionsInView = useIgnoreRegionsInView(activeViewport || null);
  const setViewport = useViewerStore((s) => s.setViewport);
  const setSelectedIgnoreId = useViewerStore((s) => s.setSelectedIgnoreId);
  const deleteSelected = useViewerStore((s) => s.deleteSelected);
  const handleDeleteIgnoreRegion = useCallback(
    (regionId: string) => {
      // The store exposes `deleteSelected` (operates on selectedIgnoreId);
      // emulate "delete by id" by selecting first, then deleting. Mirrors
      // the click-then-delete UX from the canvas/keyboard path.
      setSelectedIgnoreId(regionId);
      deleteSelected();
    },
    [setSelectedIgnoreId, deleteSelected],
  );
  const elementMapKey = candidateScreenshot?.elementMapKey ?? null;
  // Load the element map eagerly whenever a sidecar exists for the
  // candidate. Previously gated on `ignoreEditMode !== "off"`, but the
  // toolbar's "Pick element" affordance needs to know up front whether
  // the picker is available — otherwise the user enters edit mode, the
  // button is briefly disabled while the fetch races, then flips
  // enabled. The sidecar is small + browser-cached via the proxy's
  // Cache-Control header, so the unconditional fetch is cheap.
  const { map: elementMap } = useElementMap(elementMapKey);

  // Propose a smallest-containing-element snap for every fresh draft.
  // Idempotent via `pendingSnaps.has(draft.id)`; skipping drafts that
  // already carry a selector prevents re-proposing after Apply.
  useEffect(() => {
    if (!elementMap) return;
    for (const draft of draftIgnoreAreas) {
      if (pendingSnaps.has(draft.id)) continue;
      if (draft.selector) continue;
      const hit = findSmallestContainingElement(draft, elementMap.elements);
      if (hit) proposePendingSnap(draft.id, hit);
    }
  }, [draftIgnoreAreas, elementMap, pendingSnaps, proposePendingSnap]);
  // The L1 diff worker writes each step's own diff overlay PNG to
  // screenshots.diffImageKey (and the worst step's also to testRuns.diffName,
  // which only a run with a single screenshot may borrow). `legacyMissing`:
  // a step of a multi-step run diffed before steps kept their own images.
  // The run's step count is the rail's length, never `checkpoint_count`
  // (0 on runs from before it was kept): a step with no image of its own
  // waits for the rail, so it is never handed the run's image meanwhile.
  const diffName = data?.diffName ?? null;
  const stepCount = railItems?.length;
  const diffKeyOf = useCallback(
    (
      step: StepView["step"] | null,
    ): { key: string | null; legacyMissing: boolean } =>
      (step?.diffImageKey ?? null) === null && stepCount === undefined
        ? { key: null, legacyMissing: false }
        : stepDiffKey(step, { diffName, screenshotCount: stepCount ?? 0 }),
    [diffName, stepCount],
  );
  // With no step at all (a run with none), the run's own image stands.
  const { key: diffOverlayKey, legacyMissing: diffImageLegacyMissing } =
    candidateScreenshot !== null || stepCount === 0
      ? diffKeyOf(candidateScreenshot)
      : { key: null, legacyMissing: false };
  const baselineSource = currentContext.baselineSource;

  const uniqueViewports = useMemo(() => {
    const vps = (railItems ?? [])
      .map((s) => s.viewport)
      .filter((v): v is string => Boolean(v));
    return Array.from(new Set(vps));
  }, [railItems]);

  // Initialize / re-sync the editor viewport to this run's actual viewport.
  // The store viewport is stamped onto every ignore region drawn on the
  // canvas, and the API requires it non-empty (`z.string().min(1)`). The
  // ViewportSwitcher only renders for multi-viewport runs, so on a single-
  // viewport run nothing else would ever set it — leaving it "" and making
  // "Save regions" fail with a 400. The store is a module singleton, so we
  // also re-sync when landing on a run whose viewport set doesn't include
  // the (stale) carried-over value. A user's explicit switch is preserved:
  // once activeViewport is one of this run's viewports we leave it alone.
  useEffect(() => {
    if (uniqueViewports.length === 0) return;
    if (activeViewport && uniqueViewports.includes(activeViewport)) return;
    const preferred = candidateScreenshot?.viewport;
    const next =
      preferred && uniqueViewports.includes(preferred)
        ? preferred
        : uniqueViewports[0];
    if (next) setViewport(next);
  }, [uniqueViewports, activeViewport, candidateScreenshot, setViewport]);

  // The step's three images, each fetched and decoded once (spec §3.2). The
  // diff image is asked for in every mode, so switching to Diff is instant.
  const imageRequest = useMemo<ImageSetRequest>(
    () => ({
      baseline: baselineScreenshot?.imageKey ?? null,
      current: candidateScreenshot?.imageKey ?? null,
      diff: diffOverlayKey,
    }),
    [
      baselineScreenshot?.imageKey,
      candidateScreenshot?.imageKey,
      diffOverlayKey,
    ],
  );
  // The steps either side in the rail: their reads are fetched ahead now
  // (spec 2026-10-27 §5), and their images once this step's are in, the
  // next, then the previous, each with its own baseline and own diff image.
  const railAt = checkpointSummaries.findIndex(
    (c) => c.id === selectedCheckpointId,
  );
  const nextStepId =
    railAt >= 0 ? checkpointSummaries[railAt + 1]?.id : undefined;
  const prevStepId =
    railAt > 0 ? checkpointSummaries[railAt - 1]?.id : undefined;
  usePrefetchSteps(runId, [nextStepId, prevStepId]);
  const nextStep = useNeighbourStep(runId, nextStepId);
  const prevStep = useNeighbourStep(runId, prevStepId);
  // Leaving the run, its step reads go stale: its events stop reaching them.
  useStepsStaleWhenLeft(runId);
  const prefetch = useMemo<ImageSetRequest[]>(
    () =>
      [nextStep, prevStep]
        .filter((v): v is StepView => v !== undefined)
        .map((v) => ({
          baseline: v.baselineContext.baselineScreenshot?.imageKey ?? null,
          current: v.step.imageKey ?? null,
          diff: diffKeyOf(v.step).key,
        })),
    [nextStep, prevStep, diffKeyOf],
  );
  const imageSet = useImageSet(imageRequest, prefetch);

  // v1.1.20+: per-checkpoint region filter. Two checkpoints in one run
  // that share a viewport (e.g. HomePage + searchResult both at
  // 1280x720) used to see each other's diff regions overlaid. Rule: a
  // region with screenshotId === selectedCheckpointId belongs to the
  // current checkpoint. screenshotId === null is a legacy row from a
  // pre-v1.1.20 run — show on every checkpoint so legacy runs degrade
  // gracefully. Must stay above the early returns below to keep hook
  // order stable across loading/error/empty states.
  const regions = useMemo(() => {
    const all = (shownStep?.regions ?? []) as DiffRegion[];
    if (!selectedCheckpointId || selectedCheckpointId === "_first") return all;
    return all.filter(
      (r) => !r.screenshotId || r.screenshotId === selectedCheckpointId,
    );
  }, [shownStep?.regions, selectedCheckpointId]);

  // Each step, and each of its viewports, opens at fit with nothing selected
  // (spec §6.2). The view-state store outlives the viewer's remount, so the
  // reset is explicit. Reduced motion is read when the step opens: the
  // flicker starts paused under it. A layout effect, so the reset lands in
  // the step's own commit, before the browser can paint it: a cached step
  // never shows a frame at the previous step's zoom, pan, swipe or flicker
  // frame (m6).
  const resetView = useViewState((s) => s.resetView);
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  useLayoutEffect(() => {
    resetView({ reducedMotion: reducedMotionRef.current });
  }, [activeCheckpointId, activeViewport, resetView]);

  const stepper = useDiffStepper(regions);
  // ← / →'s keys, for the step buttons' hints (spec §5.4).
  const prevStepKeys = useCommandKeys("viewer.prevStep");
  const nextStepKeys = useCommandKeys("viewer.nextStep");

  // ←/→ step navigation over the checkpoint list (the reference TestStep
  // binds the arrows to "navigate"). Computed before the early-returns so the
  // shortcut hook can consume them.
  const navIndex = checkpointSummaries.findIndex(
    (c) => c.id === selectedCheckpointId,
  );
  const onPrevStep =
    navIndex > 0
      ? () => handleCheckpointSelect(checkpointSummaries[navIndex - 1]!.id)
      : undefined;
  const onNextStep =
    navIndex >= 0 && navIndex < checkpointSummaries.length - 1
      ? () => handleCheckpointSelect(checkpointSummaries[navIndex + 1]!.id)
      : undefined;

  // Back to the batch as the reviewer left it, scrolled to this run.
  const backHref = data?.buildId
    ? batchHref(data.projectId, data.buildId, context, runId)
    : undefined;

  // While the card is up, deciding and moving wait (R20): its keys are its
  // own wherever focus is. ⌘Z (the global review undo) still undoes. A
  // callback left out disables its command (`enabled`).
  const keysOn = card === null;
  // The step on screen has a failed diff (spec 2026-10-23 §10): the stage
  // says why, and a viewer who may review can retry it, from the stage or the
  // palette. This step's retry in flight is the one retry, and the palette
  // action waits for it; another step's retry does not hold this one up.
  // Whichever of the step's own read and the step list was read last says,
  // as for the header (`useReviewActions`): a read kept stale by the cache
  // never outranks a newer list.
  const listIsLatest =
    stepItem !== undefined &&
    (stepView === undefined ||
      checkpointsQuery.dataUpdatedAt >= selectedStep.dataUpdatedAt);
  const failure = listIsLatest ? stepItem : stepView?.step;
  const failedDiff =
    failure?.diffFailedAt != null ? diffErrorCode(failure.diffError) : null;
  const retryingHere =
    activeCheckpointId !== undefined && retryDiff.isPending(activeCheckpointId);
  const retryFailedDiff =
    canReview && failedDiff !== null && activeCheckpointId !== undefined
      ? () => {
          void retryDiff.retry(activeCheckpointId);
        }
      : undefined;
  useDiffViewerShortcuts({
    viewports: uniqueViewports,
    projectId: data?.projectId ?? "",
    onApprove: keysOn ? review.approve : undefined,
    onReject: keysOn ? review.reject : undefined,
    onRetryDiff: keysOn && !retryingHere ? retryFailedDiff : undefined,
    onNextDiff: stepper.next,
    onPrevDiff: stepper.prev,
    onPrevStep: keysOn ? onPrevStep : undefined,
    onNextStep: keysOn ? onNextStep : undefined,
    onNextPending: loopOn && keysOn ? loop.goNext : undefined,
    onPrevPending: loopOn && keysOn ? loop.goPrev : undefined,
    // Esc is the card's while it is up, wherever focus is: back to the batch.
    onEscape: card && backHref ? () => loop.leave(backHref) : undefined,
    // A mode's keys apply only where the step can show that mode (R2); they
    // read the mode on screen, and change it in the URL too.
    hasBaseline,
    urlView: viewerMode.view,
    setMode: viewerMode.setMode,
    available: viewerMode.available,
  });

  // The header first, then the step on screen: until both are in there is
  // nothing to show of the step (a neighbour fetched ahead is in already).
  if (isLoading || stepLoading)
    return <div className="p-4 text-sm text-fg-secondary">Loading…</div>;
  if (error ?? stepError)
    return (
      <div className="p-4 text-sm text-destructive">
        Error: {(error ?? stepError)?.message}
      </div>
    );
  if (!data)
    return <div className="p-4 text-sm text-fg-secondary">No run data.</div>;

  const isEmpty = data?.status === "empty";

  // The header's review loop. The count is the answer's, so none until it
  // has come, and none after a failed lookup (what it knew before is stale);
  // the step on screen counts in it while it needs review, and the loop's
  // cue words its count the same way (R33). Busy while a decision waits for
  // the answer (spec §5.4).
  const facetsSet = Object.keys(context.facets).length > 0;
  const headerLoop: HeaderLoop = {
    remaining:
      loop.next && !loop.error
        ? leftInBatchLabel(loop.next.remaining, facetsSet, stepHere)
        : "",
    // Inert while the card is up, as J is (R20, R28).
    onNextPending: loopOn && keysOn ? loop.goNext : undefined,
    pending: loop.pending,
    nextLabel: "Next pending",
    ...(loop.cue ? { cue: loop.cue } : {}),
    ...(loop.error
      ? { error: "Couldn't load the next step.", onRetry: loop.retry }
      : {}),
  };

  // Step prev/next for the contextual header — walks the checkpoint list.
  const cpIndex = checkpointSummaries.findIndex(
    (c) => c.id === selectedCheckpointId,
  );
  const prevCp = cpIndex > 0 ? checkpointSummaries[cpIndex - 1] : undefined;
  const nextCp =
    cpIndex >= 0 && cpIndex < checkpointSummaries.length - 1
      ? checkpointSummaries[cpIndex + 1]
      : undefined;
  const headerNav =
    cpIndex >= 0 && checkpointSummaries.length > 1
      ? {
          index: cpIndex,
          total: checkpointSummaries.length,
          onPrev: prevCp ? () => handleCheckpointSelect(prevCp.id) : undefined,
          onNext: nextCp ? () => handleCheckpointSelect(nextCp.id) : undefined,
        }
      : undefined;

  // INFO sidebar metadata (reference TestStep): test details, environment,
  // execution. Environment lives per-checkpoint on the candidate screenshot
  // (ADR-038); "Run by" comes from the run header (its build's runner), the
  // app name from the project.
  const cand = candidateScreenshot;
  const runMeta = data as {
    createdAt?: string | Date | null;
    updatedAt?: string | Date | null;
  };
  const durationMs =
    runMeta.createdAt && runMeta.updatedAt
      ? new Date(runMeta.updatedAt).getTime() -
        new Date(runMeta.createdAt).getTime()
      : null;
  const stepLabel =
    cpIndex >= 0
      ? `${cpIndex + 1}/${checkpointSummaries.length} ${
          stepItem?.name ?? ""
        }`.trim()
      : null;
  const runByName = data.runByName;
  const appName = (project as { name?: string } | undefined)?.name ?? null;

  // The metadata strip below the toolbar only carries signal in non-default
  // cases — the viewport itself already lives in the INFO sidebar. Show each
  // piece (and the strip) only when it's noteworthy so a normal run stays a
  // clean two-pane: a viewport switcher only for multi-viewport runs, the size
  // chip only on a dimension mismatch, and the baseline badge only on a
  // parent-PR / default-branch fallback (not the expected "this branch").
  const baselineSize = imageSet.images.baseline?.size;
  const currentSize = imageSet.images.current?.size;
  const sizeMismatch =
    !!baselineSize &&
    !!currentSize &&
    (baselineSize.w !== currentSize.w || baselineSize.h !== currentSize.h);
  const showViewportSwitcher = uniqueViewports.length > 1;
  const baselineFallback =
    baselineSource === "parent_pr" || baselineSource === "default_branch";
  const showMetaStrip =
    showViewportSwitcher ||
    sizeMismatch ||
    baselineFallback ||
    Boolean(data.autoApproved);
  // The selected step's own row, once read: its numbers (spec §9).
  const stepRow = stepView?.step;
  // The step on screen's own diff %, for the sidebar (R46): the run's is its
  // worst step's, another step's, and stands in only for a legacy step.
  const stepDiffPercent = stepNumber(stepRow, "diffPercent", runDiffPercent);
  // R4: the step has a pixel diff when it has a region that is pixel
  // evidence (not an accessibility finding or an audit row), or a diff
  // percent above 0. Which percent (R50, R54): a step diffed per step has
  // its own. A legacy step (generation 0, or the step not read yet) has
  // none, and borrows the run's only when the run has one screenshot (the
  // rail's count): on a run of several, the run's % may be a sibling's,
  // which would turn "No pixel changes" into "No diff image was kept" for an
  // unchanged step.
  const legacyStep = stepRow === undefined || stepRow.diffGeneration === 0;
  const stepHasDiff =
    regions.some(isPixelDiffRegion) ||
    (legacyStep
      ? stepCount === 1 && (runDiffPercent ?? 0) > 0
      : (stepRow.diffPercent ?? 0) > 0);
  // R52: a step with no verdict yet (new mid-run, or just retried) has not
  // been compared, so Diff says nothing about it. Unknown until the step or
  // the step list says.
  const awaitingDiff =
    (stepView !== undefined || stepItem !== undefined) && review.state === null;

  const viewer = (
    <div
      className="flex flex-col h-full"
      data-diff-id={diffId ?? selectedCheckpointId}
    >
      {/* Mobile gate: the diff viewer's pixi canvases + region sidebar need
          horizontal real estate the smallest phones don't have. Below the
          md breakpoint we replace the whole tree with an honest "use a
          wider screen" message instead of cramming a 320px side-by-side
          layout onto 375px (verified visually on 2026-05-24 UX audit). */}
      <div
        className="md:hidden flex flex-1 items-center justify-center p-6 text-center"
        data-testid="diff-viewer-mobile-gate"
      >
        <div className="max-w-sm space-y-3">
          <h2 className="text-base font-semibold text-fg">
            Diff review needs a wider screen
          </h2>
          <p className="text-sm text-fg-secondary">
            Reviewing pixel diffs and editing ignore regions both need the
            side-by-side canvas + region sidebar to be visible. Open this run on
            tablet or desktop to continue.
          </p>
          <p className="text-xs text-fg-muted">
            Run status:{" "}
            <span className="font-mono text-fg-secondary">
              {data?.status ?? "loading"}
            </span>
          </p>
        </div>
      </div>
      <div
        id="diff-viewer-root"
        className="hidden bg-canvas md:flex md:flex-col md:flex-1 md:min-h-0"
      >
        <ContextualHeader
          title={data.name ?? "Untitled run"}
          status={data.status}
          branch={data.branchName}
          backHref={backHref}
          nav={headerNav}
          loop={headerLoop}
          rightActions={
            <ApprovalBar
              runId={runId}
              checkpointId={activeCheckpointId}
              actions={review}
              diffRegions={regions}
              inline
              showStatus={false}
              canReview={canReview}
            />
          }
        />
        {/* Group-approval callout — inline ApprovalBar defers it here so it
            gets a full-width strip under the single-row header. Self-nulls
            when the checkpoint isn't part of a same-change group. */}
        <div id="diff-viewer-approval">
          {canReview && (
            <GroupApprovalCallout
              runId={runId}
              checkpointId={activeCheckpointId}
            />
          )}
          {/* An older run's step: approving it would put its image back as
              the baseline. Only a step that still needs a reviewer asks, and
              only a viewer who may approve. */}
          {canReview && review.view === "pending" && review.newerCapture && (
            <div className="border-b border-edge px-3 py-2">
              <StaleStepCallout
                newer={{
                  buildName: review.newerCapture.buildName,
                  runId: review.newerCapture.runId,
                  checkpointId: review.newerCapture.checkpointId,
                  projectId: data.projectId,
                }}
                context={context}
                view={viewerMode.view}
              />
            </div>
          )}
        </div>
        {card && backHref ? (
          <BatchDoneCard
            // Another card is another announcement, and takes the focus.
            key={card}
            variant={card}
            busy={loop.cardBusy}
            nextBatch={
              loop.next?.scope === "nextBatch" ? loop.next.nextBatch : null
            }
            batchUnfiltered={loop.next?.remaining.batchUnfiltered ?? 0}
            onContinue={loop.continueToNextBatch}
            onClearFilter={loop.clearFilter}
            onLeave={loop.leave}
            backHref={backHref}
            // The Batches page, with the status kept (the viewer's URL never
            // carries a branch: only the status and facets travel the loop).
            batchesHref={`/inbox${serializeReviewContext(context, ["status"])}`}
          />
        ) : isEmpty ? (
          <EmptyRunCard {...(backHref ? { buildHref: backHref } : {})} />
        ) : (
          // The toolbar and the stage read the one mode from here.
          <ViewerModeProvider value={viewerModeContext}>
            <div id="diff-viewer-toolbar">
              <ViewerToolbar
                runId={runId}
                // No step to save to until its own context (and so its saved
                // regions) has loaded: Save stays disabled meanwhile.
                checkpointId={
                  stepContextLoaded ? activeCheckpointId : undefined
                }
                projectId={data?.projectId ?? ""}
                project={{
                  dynamicTextEnabled: project?.dynamicTextEnabled ?? false,
                  diffThreshold: project?.diffThreshold ?? null,
                }}
                runDiffThresholdOverride={
                  (data as { diffThresholdOverride?: number | null })
                    ?.diffThresholdOverride ?? null
                }
                hasElementMap={!!elementMap}
                stepper={stepper}
                hasBaseline={hasBaseline}
              />
            </div>
            {showMetaStrip && (
              <div
                className="flex items-center gap-2 px-3 py-2 border-b border-edge"
                data-testid="diff-viewer-meta-strip"
              >
                {baselineFallback && (
                  <BaselineSourceBadge source={baselineSource} />
                )}
                {data.autoApproved && (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-edge bg-hover px-2 py-0.5 text-xs text-fg-secondary"
                    data-testid="auto-approved-badge"
                    title="System-approved: candidate's image bytes matched the baseline exactly."
                  >
                    Auto-approved
                  </span>
                )}
                {showViewportSwitcher && (
                  <ViewportSwitcher viewports={uniqueViewports} />
                )}
                {sizeMismatch && baselineSize && currentSize && (
                  <SizeChip
                    baseline={{ width: baselineSize.w, height: baselineSize.h }}
                    candidate={{ width: currentSize.w, height: currentSize.h }}
                  />
                )}
              </div>
            )}
            {/* Canvas + the info rail on the right (spec §5): resizable,
                collapsible, and over the canvas below 1024 px, which this
                row positions. While the ignore-region editor is open the
                rail holds its regions: one rail, never a second column.
                The left checkpoint rail was removed —
                navigation is the batch-detail grid (enter) plus the top-bar
                prev/next stepper (move between checkpoints), matching the
                reference's two-pane layout. */}
            <div className="relative flex flex-1 overflow-hidden">
              <div className="relative flex-1 min-w-0">
                <div
                  id="diff-viewer-canvas"
                  className="h-full overflow-auto"
                  data-diff-image-legacy-missing={
                    diffImageLegacyMissing ? "true" : undefined
                  }
                >
                  <ViewerStage
                    set={imageSet}
                    request={imageRequest}
                    regions={regions}
                    elementMap={elementMap ?? null}
                    legacyMissing={diffImageLegacyMissing}
                    stepHasDiff={stepHasDiff}
                    awaitingDiff={awaitingDiff}
                    checkpointId={candidateScreenshot?.id}
                    diffFailed={failedDiff}
                    onRetryDiff={retryFailedDiff}
                    retryingDiff={retryingHere}
                  />
                </div>
                {/* Large side step-arrows: navigate
                    between checkpoints; disabled at the ends. */}
                {headerNav && headerNav.total > 1 && (
                  <>
                    <button
                      type="button"
                      onClick={onPrevStep}
                      disabled={!onPrevStep}
                      aria-label="Previous step"
                      aria-keyshortcuts={prevStepKeys.ariaKeyShortcuts}
                      title={stepTitle("Previous step", prevStepKeys)}
                      data-testid="diff-viewer-step-prev"
                      className="absolute left-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-overlay/90 text-fg-secondary shadow-overlay backdrop-blur transition-colors hover:bg-overlay-hover hover:text-fg focus-ring disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronLeft className="h-5 w-5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={onNextStep}
                      disabled={!onNextStep}
                      aria-label="Next step"
                      aria-keyshortcuts={nextStepKeys.ariaKeyShortcuts}
                      title={stepTitle("Next step", nextStepKeys)}
                      data-testid="diff-viewer-step-next"
                      className="absolute right-3 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-overlay/90 text-fg-secondary shadow-overlay backdrop-blur transition-colors hover:bg-overlay-hover hover:text-fg focus-ring disabled:pointer-events-none disabled:opacity-30"
                    >
                      <ChevronRight className="h-5 w-5" aria-hidden />
                    </button>
                  </>
                )}
              </div>
              <InfoRail
                editor={{
                  content: (
                    <IgnoreRegionListPanel
                      viewport={activeViewport || null}
                      onDelete={handleDeleteIgnoreRegion}
                    />
                  ),
                  count: ignoreRegionsInView.length,
                }}
              >
                <TestInfoSidebar
                  test={data.name ?? "Untitled run"}
                  stepLabel={stepLabel}
                  match={cand?.matchLevel ?? null}
                  app={appName}
                  branch={data.branchName ?? null}
                  os={cand?.os ?? null}
                  browser={cand?.browser ?? null}
                  viewport={cand?.viewport ?? null}
                  startedAt={runMeta.createdAt ?? null}
                  duration={
                    durationMs != null ? formatDuration(durationMs) : null
                  }
                  runBy={runByName}
                  pixelDiffPercent={stepDiffPercent}
                  regions={regions}
                  vlmDescription={stepNumber(
                    stepRow,
                    "vlmDescription",
                    data?.vlmDescription,
                  )}
                  testVariationId={stepRow?.testVariationId ?? null}
                  currentBaselineKey={data.baselineName ?? null}
                  runId={runId}
                />
              </InfoRail>
              {/* Keyboard hint bar (reference TestStep): floats over the
                  canvas; ←/→ navigate steps, J/K the next / previous pending
                  step while the loop is on, A approve, R reject, and ⌘Z undo
                  while there is an action to take back. */}
              <ShortcutHints
                show={{
                  "viewer.nextPending": loopOn,
                  "viewer.prevPending": loopOn,
                  "review.undo": undoCount > 0,
                }}
              />
            </div>
          </ViewerModeProvider>
        )}
      </div>
    </div>
  );
  // The viewer's links tell the loop when their navigation starts, so a
  // mode change meanwhile takes them along (R22).
  return (
    <ViewerLinkProvider value={loop.linkNavigating}>
      {viewer}
    </ViewerLinkProvider>
  );
}

/** "Next step (→)" for a step button; none while its key is unbound. */
function stepTitle(
  label: string,
  keys: { titleSuffix: string },
): string | undefined {
  return keys.titleSuffix ? `${label}${keys.titleSuffix}` : undefined;
}

/** The hint bar's word for a command, and the test id of its group. */
const HINTS: Record<string, { text: string; testId?: string }> = {
  "viewer.prevStep": { text: "navigate" },
  "viewer.nextStep": { text: "navigate" },
  "viewer.nextPending": {
    text: "next/prev pending",
    testId: "shortcut-hint-loop",
  },
  "viewer.prevPending": {
    text: "next/prev pending",
    testId: "shortcut-hint-loop",
  },
  "review.approve": { text: "approve" },
  "review.reject": { text: "reject" },
  "review.undo": { text: "undo", testId: "shortcut-hint-undo" },
};

const HINT_KEY_CAP =
  "rounded border border-edge-strong bg-hover px-1.5 py-0.5 font-mono text-2xs text-fg-secondary";

interface HintGroup {
  text: string;
  testId?: string;
  /** One cap per command: its first key that works. */
  keys: string[];
}

/**
 * The floating key hints over the canvas (spec §4.4), made from the
 * registry's `primary` commands: the viewer's, then the global ones (⌘Z).
 * Each shows its first key; commands that share a word share a group (← →
 * navigate). A command the role may not run is never shown, nor a key the
 * single-key switch has turned off. `show` hides a command for the page's own
 * reasons (no review loop, nothing to undo).
 */
function ShortcutHints({ show }: { show: Partial<Record<string, boolean>> }) {
  const commands = useRegisteredCommands();
  const platform = usePlatform();
  const [singleKeys] = useSingleKeyShortcuts();

  const groups: HintGroup[] = [];
  const primary = commands
    .filter(({ command }) => command.primary && show[command.id] !== false)
    // The page's keys first; the order within a scope is the registry's.
    .sort(
      (a, b) => Number(a.scope === "global") - Number(b.scope === "global"),
    );
  for (const resolved of primary) {
    const { command } = resolved;
    const [live] = liveBindings(command, singleKeys);
    if (live === undefined) continue;
    const cap = formatKeyLabel(bindingKey(live), platform);
    const hint = HINTS[command.id] ?? {
      text: lowerFirst(commandLabel(resolved)),
    };
    const last = groups.at(-1);
    if (last?.text === hint.text) last.keys.push(cap);
    else groups.push({ ...hint, keys: [cap] });
  }
  if (groups.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2"
      data-testid="diff-viewer-shortcut-hints"
    >
      <div className="flex items-center gap-3 rounded-lg bg-overlay/90 px-3 py-1.5 text-xs text-fg-muted shadow-overlay backdrop-blur">
        {groups.map((group, i) => (
          <Fragment key={`${group.text}:${group.keys.join(" ")}`}>
            {i > 0 && <span className="h-3 w-px bg-edge-strong" aria-hidden />}
            <span
              className="flex items-center gap-1.5"
              data-testid={group.testId}
            >
              {group.keys.map((cap) => (
                <kbd key={cap} className={HINT_KEY_CAP}>
                  {cap}
                </kbd>
              ))}
              {group.text}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
