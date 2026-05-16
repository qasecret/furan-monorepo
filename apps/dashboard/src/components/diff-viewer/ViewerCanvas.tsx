"use client";

import { Application, type Sprite } from "pixi.js";
import { useEffect, useRef } from "react";

import { mountDiffOverlayLayer } from "./layers/DiffOverlayLayer";
import { mountImageLayer } from "./layers/ImageLayer";
import type { DiffRegion } from "./layers/regionTypes";
import { useViewerStore } from "./useViewerStore";

interface Props {
  baselineUrl: string | null;
  candidateUrl: string | null;
  diffOverlayUrl: string | null;
  regions: DiffRegion[];
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
  // Hold live sprite refs across the lifetime of the single-stage mount so
  // opacity-slider updates don't tear down + re-init pixi.
  const candidateSpriteRef = useRef<Sprite | null>(null);
  const baselineSpriteRef = useRef<Sprite | null>(null);
  const mode = useViewerStore((s) => s.mode);
  const opacity = useViewerStore((s) => s.opacity);
  // Mirror `opacity` into a ref so the single-stage mount effect can read
  // the latest value at init without listing it as a dep (which would
  // tear the scene down on every slider tick).
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;

  // Side-by-side: two independent pixi Applications, one per pane.
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

      if (baselineUrl) await mountImageLayer(baselineApp, baselineUrl);
      if (candidateUrl) await mountImageLayer(candidateApp, candidateUrl);
    })();

    return () => {
      cancelled = true;
      baselineApp.destroy(true, { children: true, texture: true });
      candidateApp.destroy(true, { children: true, texture: true });
    };
  }, [mode, baselineUrl, candidateUrl]);

  // Single-stage modes: overlay / onion-skin / diff-heatmap.
  //
  // Opacity is intentionally NOT in the dep array — we update `sprite.alpha`
  // imperatively in a separate effect (see below) so dragging the slider
  // doesn't tear down + re-init the entire pixi scene each tick.
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

      // Baseline goes underneath. Candidate sits on top so we can adjust
      // its alpha for overlay / onion-skin without flipping z-order.
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
          // mountDiffOverlayLayer adds the container to app.stage; we don't
          // need a local handle — destroy(children:true) will clean it up.
          mountDiffOverlayLayer(app, regions);
        }
      }

      // Seed initial alpha for the two slider-driven modes.
      if (
        (mode === "overlay" || mode === "onion-skin") &&
        candidateSpriteRef.current
      ) {
        candidateSpriteRef.current.alpha = opacityRef.current;
      }
      // diff-heatmap keeps both panes fully opaque; only the heatmap
      // sprite + bbox container are translucent.
    })();

    return () => {
      cancelled = true;
      candidateSpriteRef.current = null;
      baselineSpriteRef.current = null;
      app.destroy(true, { children: true, texture: true });
    };
  }, [mode, baselineUrl, candidateUrl, diffOverlayUrl, regions]);

  // Live opacity update for overlay / onion-skin. Cheap: one alpha write
  // per slider tick, no destroy/recreate.
  useEffect(() => {
    if (mode !== "overlay" && mode !== "onion-skin") return;
    const candidate = candidateSpriteRef.current;
    if (!candidate) return;
    candidate.alpha = opacity;
  }, [mode, opacity]);

  if (mode === "side-by-side") {
    return (
      <div className="grid grid-cols-2 gap-2 p-2">
        <div className="border rounded">
          <div className="text-xs text-muted-foreground p-1 border-b">
            Baseline
          </div>
          <div ref={baselineRef} data-testid="baseline-canvas-host" />
        </div>
        <div className="border rounded">
          <div className="text-xs text-muted-foreground p-1 border-b">
            Candidate
          </div>
          <div ref={candidateRef} data-testid="candidate-canvas-host" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-2">
      <div
        className="border rounded"
        ref={stageRef}
        data-testid="single-stage-host"
        data-mode={mode}
      />
    </div>
  );
}
