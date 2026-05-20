"use client";

import { Application, type Sprite } from "pixi.js";
import { useEffect, useRef, useState } from "react";

import { mountDiffOverlayLayer } from "./layers/DiffOverlayLayer";
import { mountIgnoreRegionLayer } from "./layers/IgnoreRegionLayer";
import { mountImageLayer } from "./layers/ImageLayer";
import type { DiffRegion } from "./layers/regionTypes";
import { useImageSpaceCoords } from "./useImageSpaceCoords";
import { useViewerStore, type DraftIgnoreArea } from "./useViewerStore";

interface Props {
  baselineUrl: string | null;
  candidateUrl: string | null;
  diffOverlayUrl: string | null;
  regions: DiffRegion[];
}

/** Minimum draw size in image-pixel space (anything smaller is treated as a misclick). */
const MIN_DRAW_PX = 5;

function hitTest(
  point: { x: number; y: number },
  regions: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
): string | null {
  // Iterate in reverse so topmost (later-added) regions win.
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]!;
    if (
      point.x >= r.x &&
      point.x <= r.x + r.width &&
      point.y >= r.y &&
      point.y <= r.y + r.height
    ) {
      return r.id;
    }
  }
  return null;
}

export function ViewerCanvas({
  baselineUrl,
  candidateUrl,
  diffOverlayUrl,
  regions,
}: Props) {
  const baselineRef = useRef<HTMLDivElement>(null);
  const candidateRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Live sprite + app refs so the IgnoreRegionLayer can be re-mounted on
  // store updates without tearing down the whole canvas.
  const candidateSpriteRef = useRef<Sprite | null>(null);
  const baselineSpriteRef = useRef<Sprite | null>(null);
  const candidateAppRef = useRef<Application | null>(null);
  const singleAppRef = useRef<Application | null>(null);

  const mode = useViewerStore((s) => s.mode);
  const opacity = useViewerStore((s) => s.opacity);
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;

  // Ignore-region store slices.
  const ignoreEditMode = useViewerStore((s) => s.ignoreEditMode);
  const savedRunIgnoreAreas = useViewerStore((s) => s.savedRunIgnoreAreas);
  const savedVariationIgnoreAreas = useViewerStore(
    (s) => s.savedVariationIgnoreAreas,
  );
  const draftIgnoreAreas = useViewerStore((s) => s.draftIgnoreAreas);
  const markedForDeletion = useViewerStore((s) => s.markedForDeletion);
  const paddingOverrides = useViewerStore((s) => s.paddingOverrides);
  const selectedIgnoreId = useViewerStore((s) => s.selectedIgnoreId);
  const viewport = useViewerStore((s) => s.viewport);
  const addDraftRegion = useViewerStore((s) => s.addDraftRegion);
  const setSelectedIgnoreId = useViewerStore((s) => s.setSelectedIgnoreId);

  // Side-by-side: two pixi Applications, one per pane.
  useEffect(() => {
    if (mode !== "side-by-side") return;
    const baselineApp = new Application();
    const candidateApp = new Application();
    let cancelled = false;

    (async () => {
      await baselineApp.init({
        width: 600,
        height: 400,
        backgroundColor: 0xffffff,
      });
      await candidateApp.init({
        width: 600,
        height: 400,
        backgroundColor: 0xffffff,
      });
      if (cancelled) return;
      baselineRef.current?.appendChild(baselineApp.canvas);
      candidateRef.current?.appendChild(candidateApp.canvas);

      if (baselineUrl) {
        baselineSpriteRef.current = await mountImageLayer(
          baselineApp,
          baselineUrl,
        );
      }
      if (candidateUrl) {
        candidateSpriteRef.current = await mountImageLayer(
          candidateApp,
          candidateUrl,
        );
      }
      // IgnoreRegionLayer mount effect uses candidateAppRef.current — only set
      // it after the candidate sprite has mounted so the layer doesn't briefly
      // render on an empty stage during init.
      candidateAppRef.current = candidateApp;
    })();

    return () => {
      cancelled = true;
      candidateAppRef.current = null;
      candidateSpriteRef.current = null;
      baselineSpriteRef.current = null;
      baselineApp.destroy(true, { children: true, texture: true });
      candidateApp.destroy(true, { children: true, texture: true });
    };
  }, [mode, baselineUrl, candidateUrl]);

  // Single-stage modes.
  useEffect(() => {
    if (mode === "side-by-side") return;
    const app = new Application();
    let cancelled = false;

    (async () => {
      await app.init({
        width: 1200,
        height: 800,
        backgroundColor: 0xffffff,
      });
      if (cancelled) return;
      stageRef.current?.appendChild(app.canvas);

      if (baselineUrl) {
        baselineSpriteRef.current = await mountImageLayer(app, baselineUrl);
      }
      if (candidateUrl) {
        candidateSpriteRef.current = await mountImageLayer(app, candidateUrl);
      }

      if (mode === "diff-heatmap") {
        if (diffOverlayUrl) {
          const overlaySprite = await mountImageLayer(app, diffOverlayUrl);
          overlaySprite.alpha = 0.6;
        }
        if (regions.length > 0) {
          mountDiffOverlayLayer(app, regions);
        }
      }

      if (
        (mode === "overlay" || mode === "onion-skin") &&
        candidateSpriteRef.current
      ) {
        candidateSpriteRef.current.alpha = opacityRef.current;
      }
      // IgnoreRegionLayer mount effect uses singleAppRef.current — only set
      // it after all mountImageLayer calls (including the diff-heatmap branch)
      // so the layer doesn't briefly render on an empty stage during init.
      singleAppRef.current = app;
    })();

    return () => {
      cancelled = true;
      singleAppRef.current = null;
      candidateSpriteRef.current = null;
      baselineSpriteRef.current = null;
      app.destroy(true, { children: true, texture: true });
    };
  }, [mode, baselineUrl, candidateUrl, diffOverlayUrl, regions]);

  // Live opacity update.
  useEffect(() => {
    if (mode !== "overlay" && mode !== "onion-skin") return;
    const candidate = candidateSpriteRef.current;
    if (!candidate) return;
    candidate.alpha = opacity;
  }, [mode, opacity]);

  // Remount the IgnoreRegionLayer whenever the store data or edit scope
  // changes. The layer is cheap to construct (one Graphics per region).
  useEffect(() => {
    const app =
      mode === "side-by-side" ? candidateAppRef.current : singleAppRef.current;
    if (!app) return;
    // Apply paddingOverrides to saved regions before handing them to the
    // layer; the layer itself doesn't know about overrides. Drafts mutate
    // in place via setPaddingForSelected, so they don't need this mapping.
    const savedRunWithOverrides = savedRunIgnoreAreas.map((r) => ({
      ...r,
      paddingPx: paddingOverrides.get(r.id) ?? r.paddingPx,
    }));
    const savedVariationWithOverrides = savedVariationIgnoreAreas.map((r) => ({
      ...r,
      paddingPx: paddingOverrides.get(r.id) ?? r.paddingPx,
    }));
    const layer = mountIgnoreRegionLayer(app, {
      editMode: ignoreEditMode,
      savedRunIgnoreAreas: savedRunWithOverrides,
      savedVariationIgnoreAreas: savedVariationWithOverrides,
      draftIgnoreAreas,
      markedForDeletion,
      selectedIgnoreId,
      viewport,
      onSelect: (id) => setSelectedIgnoreId(id),
    });
    return () => {
      layer.destroy({ children: true });
    };
  }, [
    mode,
    ignoreEditMode,
    savedRunIgnoreAreas,
    savedVariationIgnoreAreas,
    draftIgnoreAreas,
    markedForDeletion,
    paddingOverrides,
    selectedIgnoreId,
    viewport,
    setSelectedIgnoreId,
  ]);

  // Drag-to-draw pointer overlay.
  const activeAppRef = mode === "side-by-side" ? candidateAppRef : singleAppRef;
  const toImage = useImageSpaceCoords({
    appRef: activeAppRef,
    spriteRef: candidateSpriteRef,
  });

  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragCurrent, setDragCurrent] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const overlayActive = ignoreEditMode !== "off";

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayActive) return;
    const pt = toImage(e);
    if (!pt) return;
    setDragStart(pt);
    setDragCurrent(pt);
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayActive || !dragStart) return;
    const pt = toImage(e);
    if (!pt) return;
    setDragCurrent(pt);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayActive || !dragStart) return;
    const pt = toImage(e) ?? dragCurrent;
    setDragStart(null);
    setDragCurrent(null);
    (e.target as HTMLDivElement).releasePointerCapture(e.pointerId);
    if (!pt) return;
    const x = Math.min(dragStart.x, pt.x);
    const y = Math.min(dragStart.y, pt.y);
    const width = Math.abs(pt.x - dragStart.x);
    const height = Math.abs(pt.y - dragStart.y);
    if (width < MIN_DRAW_PX || height < MIN_DRAW_PX) {
      // Treat as a click (not a drag). Hit-test active-scope regions
      // for selection; clicks on empty area deselect.
      const activeSaved =
        ignoreEditMode === "variation"
          ? savedVariationIgnoreAreas
          : savedRunIgnoreAreas;
      const candidates = [
        ...activeSaved.filter((r) => !r.viewport || r.viewport === viewport),
        ...draftIgnoreAreas,
      ];
      const hit = hitTest(dragStart, candidates);
      setSelectedIgnoreId(hit);
      return;
    }
    const draft: DraftIgnoreArea = {
      id: crypto.randomUUID(),
      x,
      y,
      width,
      height,
      viewport,
      paddingPx: 0,
      kind: "ignore",
    };
    addDraftRegion(draft);
  };

  const handlePointerCancel = (_e: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayActive) return;
    setDragStart(null);
    setDragCurrent(null);
  };

  if (mode === "side-by-side") {
    return (
      <div className="grid grid-cols-2 gap-2 p-2">
        <div className="border rounded">
          <div className="text-xs text-muted-foreground p-1 border-b">
            Baseline
          </div>
          <div ref={baselineRef} data-testid="baseline-canvas-host" />
        </div>
        <div className="border rounded relative">
          <div className="text-xs text-muted-foreground p-1 border-b">
            Candidate
          </div>
          <div ref={candidateRef} data-testid="candidate-canvas-host" />
          {overlayActive && (
            <div
              className="absolute inset-0 cursor-crosshair"
              data-testid="ignore-region-overlay"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 relative">
      <div
        className="border rounded"
        ref={stageRef}
        data-testid="single-stage-host"
        data-mode={mode}
      />
      {overlayActive && (
        <div
          className="absolute inset-2 cursor-crosshair"
          data-testid="ignore-region-overlay"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
      )}
    </div>
  );
}
