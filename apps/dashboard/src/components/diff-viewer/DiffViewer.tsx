"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApprovalBar } from "./ApprovalBar";
import { BaselineHistoryPanel } from "./BaselineHistoryPanel";
import { BaselineSourceBadge } from "./BaselineSourceBadge";
import { CheckpointRail, type CheckpointSummary } from "./CheckpointRail";
import { ContextualHeader } from "./ContextualHeader";
import { EmptyRunCard } from "./EmptyRunCard";
import { IgnoreRegionListPanel } from "./IgnoreRegionListPanel";
import type { DiffRegion } from "./layers/regionTypes";
import { RegionListPanel } from "./RegionListPanel";
import { RunCommentPanel } from "./RunCommentPanel";
import { SizeChip } from "./SizeChip";
import { findSmallestContainingElement } from "./snap-to-element";
import { useDiffViewerShortcuts } from "./useDiffViewerShortcuts";
import { useElementMap } from "./useElementMap";
import { useViewerStore } from "./useViewerStore";
import { ViewerCanvas } from "./ViewerCanvas";
import { ViewerToolbar } from "./ViewerToolbar";
import { ViewportSwitcher } from "./ViewportSwitcher";

import { useRunEvents, type RunEvent } from "@/hooks/useRunEvents";
import { browserEnv } from "@/lib/env";
import { trpc } from "@/lib/trpc";

interface Props {
  runId: string;
  /** @deprecated use initialCheckpointId + projectId. Kept for legacy diffs route compat. */
  diffId?: string;
  /** ADR-038: project id for building canonical checkpoint URLs. */
  projectId?: string;
  /** ADR-038: checkpoint id to display initially; "_first" means use the first checkpoint. */
  initialCheckpointId?: string;
}

/**
 * Resolves a storage key to a blob: URL by fetching the authenticated
 * `/api/v1/storage/:key` proxy with `credentials: "include"`. We can't
 * hand the proxy URL straight to pixi's `Assets.load` because pixi's
 * loader doesn't propagate cookies. Pre-fetching → object URL is
 * cookie-aware and works across browsers.
 */
function useAuthedImage(key: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    let active = true;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(
          `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/storage/${key}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          if (active) setUrl(null);
          return;
        }
        const blob = await res.blob();
        if (!active) return;
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
      } catch {
        if (active) setUrl(null);
      }
    })();
    return () => {
      active = false;
      // Defer revoke so downstream consumers — primarily Pixi's async
      // mountImageLayer — can finish loading from the blob URL before
      // it's invalidated. Without the delay, switching checkpoints
      // while Pixi is still fetching produced "Failed to fetch" /
      // "WebGL: INVALID_VALUE: texImage2D: bad image data" and left
      // the canvas blank until a hard reload.
      if (createdUrl) {
        const toRevoke = createdUrl;
        setTimeout(() => URL.revokeObjectURL(toRevoke), 10_000);
      }
    };
  }, [key]);
  return url;
}

/**
 * Resolves the natural pixel dimensions of an image URL. Creates a
 * temporary Image() object, fires on `load`, then returns the measured
 * width + height. Returns null until the image has loaded or if the URL is
 * absent. The effect re-runs whenever the URL changes (e.g. viewport
 * switch), keeping the chip in sync.
 */
function useImageDimensions(
  url: string | null,
): { width: number; height: number } | null {
  const [dims, setDims] = useState<{ width: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    if (!url) {
      setDims(null);
      return;
    }
    const img = new Image();
    img.onload = () =>
      setDims({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return dims;
}

export function DiffViewer({
  runId,
  diffId,
  projectId,
  initialCheckpointId,
}: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();

  // ADR-038: checkpoint selection state
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string>(
    initialCheckpointId ?? diffId ?? "_first",
  );

  // ADR-038: fetch the checkpoint list for the rail
  const checkpointsQuery = trpc.runs.listCheckpoints.useQuery({ runId });

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
          router.replace(
            `/projects/${projectId}/runs/${runId}/checkpoints/${firstId}`,
          );
        }
      }
    }
  }, [selectedCheckpointId, checkpointsQuery.data, projectId, runId, router]);

  // ADR-038: sync URL when user navigates between checkpoints
  const handleCheckpointSelect = useCallback(
    (id: string) => {
      setSelectedCheckpointId(id);
      if (projectId) {
        router.replace(
          `/projects/${projectId}/runs/${runId}/checkpoints/${id}`,
        );
      }
    },
    [projectId, runId, router],
  );

  // ADR-038: map checkpoint items to CheckpointSummary[] for the rail.
  // listCheckpoints now returns a derived per-checkpoint status:
  //   "new"        if the variation has no baseline yet
  //   "unresolved" if any diff_regions exist for the (run_id, viewport)
  //   "passed"     otherwise
  // diffPercent stays null until diff_regions gains a screenshot_id column
  // (deferred — see runs.ts listCheckpoints comment).
  const checkpointSummaries: CheckpointSummary[] = useMemo(() => {
    return (checkpointsQuery.data?.items ?? []).map((item) => ({
      id: item.id,
      name: item.name ?? item.id,
      status: item.status,
      diffPercent: null,
    }));
  }, [checkpointsQuery.data]);
  const { data, isLoading, error } = trpc.runs.getById.useQuery({ runId });
  // Sibling fetch for project settings the viewer needs (currently
  // `dynamicTextEnabled`, which gates the kind selector + PatternEditor).
  // Enabled only after `data` lands so we don't fire with an empty id.
  const projectQuery = trpc.projects.getById.useQuery(
    { projectId: data?.projectId ?? "" },
    { enabled: !!data?.projectId },
  );
  const project = projectQuery.data;

  // T11: keyboard-shortcut mutations. These are deliberately separate hook
  // instances from the ones inside <ApprovalBar>; both invalidate the same
  // runs.getById query on success, so the UI converges regardless of source.
  const approveKb = trpc.runs.approve.useMutation({
    onSuccess: () => void utils.runs.getById.invalidate({ runId }),
  });
  const rejectKb = trpc.runs.reject.useMutation({
    onSuccess: () => void utils.runs.getById.invalidate({ runId }),
  });

  // T11: SSE — invalidate runs.getById on terminal worker events so the
  // viewer picks up freshly written diff regions, baselineSource, etc.
  const onSseEvent = useCallback(
    (e: RunEvent) => {
      if (
        e.type === "diff.completed" ||
        e.type === "capture.completed" ||
        e.type === "run.completed"
      ) {
        void utils.runs.getById.invalidate({ runId });
      }
    },
    [utils, runId],
  );
  useRunEvents(runId, onSseEvent);

  // ADR-031: hydrate the ignore-region editor's saved slices from the
  // run + variation payload. The store's hydrateSavedIgnoreAreas
  // preserves drafts + markedForDeletion when unsaved changes exist
  // (guards against silent loss on react-query refetch / SSE refresh).
  const hydrateSavedIgnoreAreas = useViewerStore(
    (s) => s.hydrateSavedIgnoreAreas,
  );
  // Select the candidate by selectedCheckpointId, falling back to the
  // first screenshot. Before the fix this was hardcoded to screenshots[0],
  // so the viewer always rendered the first checkpoint's image no matter
  // which row was selected in the rail.
  const candidateScreenshot = useMemo(() => {
    const shots = data?.screenshots ?? [];
    if (selectedCheckpointId && selectedCheckpointId !== "_first") {
      const match = shots.find(
        (s) => (s as { id?: string }).id === selectedCheckpointId,
      );
      if (match) return match;
    }
    return shots[0] ?? null;
  }, [data?.screenshots, selectedCheckpointId]);

  // Per-checkpoint baseline + variation context. Server populates
  // `checkpointContexts` keyed by screenshot id. Top-level fields on
  // `data` are kept for back-compat (and as a fallback) but only carry
  // the FIRST checkpoint's resolution.
  const currentContext = useMemo(() => {
    const ctxs =
      (
        data as {
          checkpointContexts?: Record<
            string,
            {
              baselineScreenshot: typeof candidateScreenshot;
              baselineSource: string | null;
              variationIgnoreAreas: unknown[] | null;
            }
          >;
        } | null
      )?.checkpointContexts ?? {};
    if (candidateScreenshot?.id && ctxs[candidateScreenshot.id]) {
      return ctxs[candidateScreenshot.id]!;
    }
    return {
      baselineScreenshot: data?.baselineScreenshot ?? null,
      baselineSource: data?.baselineSource ?? null,
      variationIgnoreAreas: data?.variationIgnoreAreas ?? null,
    };
  }, [data, candidateScreenshot]);

  const baselineScreenshot = currentContext.baselineScreenshot;

  useEffect(() => {
    // Server payload may predate the paddingPx column (legacy rows have
    // no paddingPx); hydrateSavedIgnoreAreas applies `?? 0` so we widen
    // the cast and let the store normalize.
    const runRegions = (data?.ignoreAreas ?? []) as Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      viewport: string;
      paddingPx?: number;
      kind?: "ignore" | "dynamic-text";
      pattern?: string;
    }>;
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
      runRegions.map((r) => ({
        ...r,
        paddingPx: r.paddingPx ?? 0,
        kind: r.kind ?? "ignore",
      })),
      variationRegions.map((r) => ({
        ...r,
        paddingPx: r.paddingPx ?? 0,
        kind: r.kind ?? "ignore",
      })),
    );
  }, [
    data?.ignoreAreas,
    currentContext.variationIgnoreAreas,
    hydrateSavedIgnoreAreas,
  ]);

  // F-a/3: lazily fetch the candidate's element-map sidecar when in
  // ignore-edit mode AND the screenshot row has a key. Old runs that
  // predate PR #61 carry `elementMapKey === null`; the hook treats
  // null as "idle" so the proxy is never hit.
  const draftIgnoreAreas = useViewerStore((s) => s.draftIgnoreAreas);
  const pendingSnaps = useViewerStore((s) => s.pendingSnaps);
  const proposePendingSnap = useViewerStore((s) => s.proposePendingSnap);
  // Phase 1.4: list panel mount gate + delete wiring. Reads here so they
  // sit alongside the other ignore-editor selectors (the actual JSX
  // mount is next to RegionListPanel below).
  const ignoreEditMode = useViewerStore((s) => s.ignoreEditMode);
  const activeViewport = useViewerStore((s) => s.viewport);
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
  const elementMapKey =
    (candidateScreenshot as { elementMapKey?: string | null } | null)
      ?.elementMapKey ?? null;
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
  // The L1 diff worker writes the diff overlay PNG to testRuns.diffName (key).
  const diffOverlayKey = data?.diffName ?? null;
  const baselineSource = currentContext.baselineSource;

  const uniqueViewports = useMemo(() => {
    const shots = data?.screenshots ?? [];
    const vps = shots
      .map((s) => (s as { viewport?: string | null }).viewport ?? null)
      .filter((v): v is string => Boolean(v));
    return Array.from(new Set(vps));
  }, [data?.screenshots]);

  const baselineUrl = useAuthedImage(baselineScreenshot?.imageKey);
  const candidateUrl = useAuthedImage(candidateScreenshot?.imageKey);
  const diffOverlayUrl = useAuthedImage(diffOverlayKey);

  const baselineDims = useImageDimensions(baselineUrl);
  const candidateDims = useImageDimensions(candidateUrl);

  useDiffViewerShortcuts({
    viewports: uniqueViewports,
    projectId: data?.projectId ?? "",
    prevDiffHref: data?.prevRunId
      ? `/projects/${data.projectId}/runs/${data.prevRunId}/diffs/${data.prevRunId}`
      : null,
    nextDiffHref: data?.nextRunId
      ? `/projects/${data.projectId}/runs/${data.nextRunId}/diffs/${data.nextRunId}`
      : null,
    onApprove: () => approveKb.mutate({ runId }),
    onReject: () => rejectKb.mutate({ runId }),
    onHelpToggle: () => undefined,
  });

  if (isLoading)
    return (
      <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">
        Loading…
      </div>
    );
  if (error)
    return (
      <div className="p-4 text-sm text-red-400">Error: {error.message}</div>
    );
  if (!data)
    return (
      <div className="p-4 text-sm text-zinc-600 dark:text-zinc-400">
        No run data.
      </div>
    );

  // v1.1.20+: per-checkpoint region filter. Before the diff_regions
  // schema gained a screenshot_id column, two checkpoints in one run
  // that shared a viewport (e.g. HomePage + searchResult both at
  // 1280x720) saw each other's diff regions overlaid in the diff
  // viewer — Applitools users immediately noticed yellow boxes on
  // pages that hadn't actually changed there.
  //
  // Rule: a region with screenshotId === selectedCheckpointId belongs
  // to the current checkpoint. A region with screenshotId === null is
  // a legacy row from a pre-v1.1.20 run; we show it on every
  // checkpoint so legacy runs degrade gracefully rather than
  // disappearing entirely.
  const regions = useMemo(() => {
    const all = (data.diffRegions ?? []) as DiffRegion[];
    if (!selectedCheckpointId || selectedCheckpointId === "_first") return all;
    return all.filter(
      (r) => !r.screenshotId || r.screenshotId === selectedCheckpointId,
    );
  }, [data.diffRegions, selectedCheckpointId]);

  const isEmpty = data?.status === "empty";

  return (
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
          <h2 className="text-base font-semibold text-zinc-950 dark:text-white">
            Diff review needs a wider screen
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Reviewing pixel diffs and editing ignore regions both need the
            side-by-side canvas + region sidebar to be visible. Open this run on
            tablet or desktop to continue.
          </p>
          <p className="text-xs text-zinc-500">
            Run status:{" "}
            <span className="font-mono text-zinc-700 dark:text-zinc-300">
              {data?.status ?? "loading"}
            </span>
          </p>
        </div>
      </div>
      <div className="hidden md:flex md:flex-col md:flex-1 md:min-h-0">
        <ContextualHeader
          breadcrumb={[
            { label: "Projects", href: "/projects" },
            {
              label: project?.name ?? "Project",
              href: `/projects/${data.projectId}`,
            },
            { label: "Runs", href: `/projects/${data.projectId}/runs` },
            { label: data.name ?? `Run ${data.id.slice(0, 8)}` },
          ]}
          title={data.name ?? "Untitled run"}
          status={data.status}
          metadata={{
            branch: data.branchName,
            checkpointCount:
              data.checkpointCount ??
              checkpointsQuery.data?.items?.length ??
              null,
            startedAt: data.createdAt,
            completedAt: data.completedAt,
          }}
        />
        {isEmpty ? (
          <EmptyRunCard
            projectId={data.projectId}
            buildId={data.buildId ?? null}
          />
        ) : (
          <>
            <div id="diff-viewer-toolbar">
              <ViewerToolbar
                runId={runId}
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
              />
            </div>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
              <BaselineSourceBadge source={baselineSource} />
              {data.autoApproved && (
                <span
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                  data-testid="auto-approved-badge"
                  title="System-approved: candidate's image bytes matched the baseline exactly."
                >
                  Auto-approved
                </span>
              )}
              <ViewportSwitcher viewports={uniqueViewports} />
              {baselineDims && candidateDims && (
                <SizeChip baseline={baselineDims} candidate={candidateDims} />
              )}
              {/*
                ADR-038: BaselineHistoryPanel binds to the currently-selected
                checkpoint's testVariationId, not the run's (the run no longer
                has one — it has N checkpoints with one variation each).
              */}
              {(() => {
                const selectedCheckpoint = checkpointsQuery.data?.items?.find(
                  (c) => c.id === selectedCheckpointId,
                );
                if (!selectedCheckpoint?.testVariationId) return null;
                return (
                  <BaselineHistoryPanel
                    testVariationId={selectedCheckpoint.testVariationId}
                    currentBaselineKey={data.baselineName ?? null}
                  />
                );
              })()}
            </div>
            {/* ADR-038: checkpoint rail left column + canvas/right-rail */}
            <div className="flex flex-1 overflow-hidden">
              {/* Checkpoint rail: 240px left column listing all checkpoints */}
              {checkpointSummaries.length > 0 &&
                selectedCheckpointId !== "_first" && (
                  <CheckpointRail
                    items={checkpointSummaries}
                    selectedId={selectedCheckpointId}
                    onSelect={handleCheckpointSelect}
                  />
                )}
              <div id="diff-viewer-canvas" className="flex-1 overflow-auto">
                <ViewerCanvas
                  baselineUrl={baselineUrl}
                  candidateUrl={candidateUrl}
                  diffOverlayUrl={diffOverlayUrl}
                  regions={regions}
                  elementMap={elementMap ?? null}
                />
              </div>
              <RegionListPanel regions={regions} />
              {ignoreEditMode !== "off" && (
                <IgnoreRegionListPanel
                  viewport={activeViewport || null}
                  onDelete={handleDeleteIgnoreRegion}
                />
              )}
            </div>
          </>
        )}
        <div id="diff-viewer-approval">
          <ApprovalBar
            runId={runId}
            checkpointId={
              selectedCheckpointId !== "_first"
                ? selectedCheckpointId
                : undefined
            }
            status={data?.status}
            diffRegions={data?.diffRegions}
          />
        </div>
        <RunCommentPanel runId={runId} />
      </div>
    </div>
  );
}
