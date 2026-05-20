"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApprovalBar } from "./ApprovalBar";
import { BaselineSourceBadge } from "./BaselineSourceBadge";
import { EmptyRunCard } from "./EmptyRunCard";
import type { DiffRegion } from "./layers/regionTypes";
import { RegionListPanel } from "./RegionListPanel";
import { RunCommentPanel } from "./RunCommentPanel";
import { useDiffViewerShortcuts } from "./useDiffViewerShortcuts";
import { useViewerStore } from "./useViewerStore";
import { ViewerCanvas } from "./ViewerCanvas";
import { ViewerToolbar } from "./ViewerToolbar";
import { ViewportSwitcher } from "./ViewportSwitcher";

import { useRunEvents, type RunEvent } from "@/hooks/useRunEvents";
import { browserEnv } from "@/lib/env";
import { trpc } from "@/lib/trpc";

interface Props {
  runId: string;
  diffId: string;
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
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [key]);
  return url;
}

export function DiffViewer({ runId, diffId }: Props) {
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.runs.getById.useQuery({ runId });

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
    const variationRegions = (data?.variationIgnoreAreas ?? []) as Array<{
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
  }, [data?.ignoreAreas, data?.variationIgnoreAreas, hydrateSavedIgnoreAreas]);

  const candidateScreenshot = data?.screenshots?.[0] ?? null;
  const baselineScreenshot = data?.baselineScreenshot ?? null;
  // The L1 diff worker writes the diff overlay PNG to testRuns.diffName (key).
  const diffOverlayKey = data?.diffName ?? null;
  const baselineSource = data?.baselineSource ?? null;

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

  useDiffViewerShortcuts({
    viewports: uniqueViewports,
    prevDiffHref: null, // wired when runs.list lands (Phase 3)
    nextDiffHref: null,
    onApprove: () => approveKb.mutate({ runId }),
    onReject: () => rejectKb.mutate({ runId }),
    onHelpToggle: () => undefined,
  });

  if (isLoading) return <div className="p-4">Loading…</div>;
  if (error)
    return <div className="p-4 text-destructive">Error: {error.message}</div>;
  if (!data) return <div className="p-4">No run data.</div>;

  const regions = (data.diffRegions ?? []) as DiffRegion[];

  const isEmpty = data?.status === "empty";

  return (
    <div className="flex flex-col h-full" data-diff-id={diffId}>
      {isEmpty ? (
        <EmptyRunCard
          projectId={data.projectId}
          buildId={data.buildId ?? null}
        />
      ) : (
        <>
          <ViewerToolbar runId={runId} />
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <BaselineSourceBadge source={baselineSource} />
            {data.autoApproved && (
              <span
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                data-testid="auto-approved-badge"
                title="System-approved: candidate's image bytes matched the baseline exactly."
              >
                Auto-approved
              </span>
            )}
            <ViewportSwitcher viewports={uniqueViewports} />
          </div>
          <div className="flex flex-1 overflow-hidden">
            <div className="flex-1 overflow-auto">
              <ViewerCanvas
                baselineUrl={baselineUrl}
                candidateUrl={candidateUrl}
                diffOverlayUrl={diffOverlayUrl}
                regions={regions}
              />
            </div>
            <RegionListPanel regions={regions} />
          </div>
        </>
      )}
      <ApprovalBar
        runId={runId}
        status={data?.status}
        diffRegions={data?.diffRegions}
      />
      <RunCommentPanel runId={runId} />
    </div>
  );
}
