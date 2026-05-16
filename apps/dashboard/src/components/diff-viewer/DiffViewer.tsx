"use client";

import { useEffect, useMemo, useState } from "react";

import { BaselineSourceBadge } from "./BaselineSourceBadge";
import type { DiffRegion } from "./layers/regionTypes";
import { RegionListPanel } from "./RegionListPanel";
import { useDiffViewerShortcuts } from "./useDiffViewerShortcuts";
import { ViewerCanvas } from "./ViewerCanvas";
import { ViewerToolbar } from "./ViewerToolbar";
import { ViewportSwitcher } from "./ViewportSwitcher";

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
  const { data, isLoading, error } = trpc.runs.getById.useQuery({ runId });

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
    onApprove: () => undefined, // T11 fills in
    onReject: () => undefined,
    onHelpToggle: () => undefined,
  });

  if (isLoading) return <div className="p-4">Loading…</div>;
  if (error)
    return <div className="p-4 text-destructive">Error: {error.message}</div>;
  if (!data) return <div className="p-4">No run data.</div>;

  const regions = (data.diffRegions ?? []) as DiffRegion[];

  return (
    <div className="flex flex-col h-full" data-diff-id={diffId}>
      <ViewerToolbar />
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <BaselineSourceBadge source={baselineSource} />
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
    </div>
  );
}
