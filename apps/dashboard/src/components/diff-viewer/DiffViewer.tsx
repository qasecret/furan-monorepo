"use client";

import { useEffect, useState } from "react";

import type { DiffRegion } from "./layers/regionTypes";
import { ViewerCanvas } from "./ViewerCanvas";
import { ViewerToolbar } from "./ViewerToolbar";

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

  const baselineUrl = useAuthedImage(baselineScreenshot?.imageKey);
  const candidateUrl = useAuthedImage(candidateScreenshot?.imageKey);
  const diffOverlayUrl = useAuthedImage(diffOverlayKey);

  if (isLoading) return <div className="p-4">Loading…</div>;
  if (error)
    return <div className="p-4 text-destructive">Error: {error.message}</div>;
  if (!data) return <div className="p-4">No run data.</div>;

  const regions = (data.diffRegions ?? []) as DiffRegion[];

  return (
    <div className="flex flex-col h-full" data-diff-id={diffId}>
      <ViewerToolbar />
      <ViewerCanvas
        baselineUrl={baselineUrl}
        candidateUrl={candidateUrl}
        diffOverlayUrl={diffOverlayUrl}
        regions={regions}
      />
    </div>
  );
}
