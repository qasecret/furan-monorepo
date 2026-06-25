"use client";

import { Application, Container, type Sprite } from "pixi.js";
import { useEffect, useRef, useState } from "react";

import { orderDiffRegions } from "./diff-order";
import { mountDiffOverlayLayer } from "./layers/DiffOverlayLayer";
import type { ShadingLayerResult } from "./layers/DiffShadingLayer";
import { mountDiffShadingLayer } from "./layers/DiffShadingLayer";
import { mountIgnoreRegionLayer } from "./layers/IgnoreRegionLayer";
import { mountImageLayer } from "./layers/ImageLayer";
import type { DiffRegion } from "./layers/regionTypes";
import { findSmallestElementAtPoint } from "./snap-to-element";
import {
  applyViewToPane,
  attachCanvasViewControl,
} from "./useCanvasViewControl";
import type { ElementBbox, ElementMap } from "./useElementMap";
import { useImageSpaceCoords } from "./useImageSpaceCoords";
import { useReducedMotion } from "./useReducedMotion";
import {
  useViewerStore,
  type DraftIgnoreArea,
  type IgnoreArea,
} from "./useViewerStore";
import { computeFocusView, fitWorldToCanvas } from "./world-fit";

interface Props {
  baselineUrl: string | null;
  candidateUrl: string | null;
  diffOverlayUrl: string | null;
  regions: DiffRegion[];
  /**
   * Element-map sidecar for the candidate screenshot (PR #61). When
   * present AND the user is in `regionInputMode === "pick"`, the
   * canvas resolves the cursor to the smallest containing element on
   * hover + creates a draft region at that element's bbox on click.
   * `null` when the sidecar is missing — the picker silently degrades
   * to drag-only.
   */
  elementMap?: ElementMap | null;
  /**
   * Natural pixel dimensions of each image. Used to size each card to its
   * image's aspect ratio so a short/landscape screenshot fills its card
   * instead of sitting in a tall box with big empty bands above and below.
   */
  baselineDims?: { width: number; height: number } | null;
  candidateDims?: { width: number; height: number } | null;
}

/** Card aspect-ratio style from natural image dims (no-op until measured). */
function aspectStyle(
  dims?: { width: number; height: number } | null,
): React.CSSProperties | undefined {
  return dims && dims.width > 0 && dims.height > 0
    ? { aspectRatio: `${dims.width} / ${dims.height}` }
    : undefined;
}

/** Minimum draw size in image-pixel space (anything smaller is treated as a misclick). */
const MIN_DRAW_PX = 5;

/** Fallback dimensions used before the host element has been laid out. */
const FALLBACK_W = 800;
const FALLBACK_H = 600;

function hostSize(el: HTMLElement | null): { w: number; h: number } {
  if (!el) return { w: FALLBACK_W, h: FALLBACK_H };
  const w = el.clientWidth || FALLBACK_W;
  const h = el.clientHeight || FALLBACK_H;
  return { w, h };
}

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
  elementMap,
  baselineDims,
  candidateDims,
}: Props) {
  const baselineRef = useRef<HTMLDivElement>(null);
  const candidateRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Live sprite + app refs so the IgnoreRegionLayer can be re-mounted on
  // store updates without tearing down the whole canvas.
  const candidateSpriteRef = useRef<Sprite | null>(null);
  const baselineSpriteRef = useRef<Sprite | null>(null);
  const candidateAppRef = useRef<Application | null>(null);
  const baselineAppRef = useRef<Application | null>(null);
  const singleAppRef = useRef<Application | null>(null);
  // World containers per Application. All overlays (image, regions, diff
  // highlights) parent into the world container so a single
  // scale + translate handles fit-to-canvas (and future zoom + pan).
  const candidateWorldRef = useRef<Container | null>(null);
  const baselineWorldRef = useRef<Container | null>(null);
  const singleWorldRef = useRef<Container | null>(null);
  // Overlay region layer ref so the rebuild effect can detach the previous
  // mount before adding a new one (previously returned from the effect's
  // setup as a closure — now refs because the world-container plumbing
  // is shared across multiple effects).
  const regionLayerRef = useRef<Container | null>(null);
  // Shading layer result ref so the side-by-side effect cleanup can call
  // destroy() to unregister the pulse ticker callback.
  const shadingLayerRef = useRef<ShadingLayerResult | null>(null);

  const mode = useViewerStore((s) => s.mode);
  const opacity = useViewerStore((s) => s.opacity);
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;
  const highlightActive = useViewerStore((s) => s.highlightActive);
  const reducedMotion = useReducedMotion();
  // Zoom + pan state, applied uniformly to every pane via fitWorldToCanvas.
  const zoom = useViewerStore((s) => s.zoom);
  const panX = useViewerStore((s) => s.panX);
  const panY = useViewerStore((s) => s.panY);
  const focusBbox = useViewerStore((s) => s.focusBbox);
  const setView = useViewerStore((s) => s.setView);
  const setFocusBbox = useViewerStore((s) => s.setFocusBbox);

  // Ignore-region store slices.
  const ignoreEditMode = useViewerStore((s) => s.ignoreEditMode);
  const savedRunIgnoreAreas = useViewerStore((s) => s.savedRunIgnoreAreas);
  const savedVariationIgnoreAreas = useViewerStore(
    (s) => s.savedVariationIgnoreAreas,
  );
  const draftIgnoreAreas = useViewerStore((s) => s.draftIgnoreAreas);
  const markedForDeletion = useViewerStore((s) => s.markedForDeletion);
  const paddingOverrides = useViewerStore((s) => s.paddingOverrides);
  const kindOverrides = useViewerStore((s) => s.kindOverrides);
  const selectedIgnoreId = useViewerStore((s) => s.selectedIgnoreId);
  const selectedRegionId = useViewerStore((s) => s.selectedRegionId);
  const setSelected = useViewerStore((s) => s.setSelected);
  const viewport = useViewerStore((s) => s.viewport);
  const addDraftRegion = useViewerStore((s) => s.addDraftRegion);
  const setSelectedIgnoreId = useViewerStore((s) => s.setSelectedIgnoreId);
  const regionInputMode = useViewerStore((s) => s.regionInputMode);
  // Hovered element under the cursor in pick mode. Kept as state so the
  // ignore-region layer re-renders the preview rect on every hover step.
  const [pickPreview, setPickPreview] = useState<ElementBbox | null>(null);

  // Timing bridge: the heavy mount effect bumps this after the fresh world +
  // app refs are populated. The shading effect listens to this value so it
  // fires once the canvas is ready without refs triggering re-runs themselves.
  const [canvasEpoch, setCanvasEpoch] = useState(0);

  // Side-by-side: two pixi Applications, one per pane.
  // ONLY re-runs when the mode or image URLs change — NOT on overlay changes.
  useEffect(() => {
    if (mode !== "side-by-side") return;
    const baselineApp = new Application();
    const candidateApp = new Application();
    let cancelled = false;
    // AbortController so an in-flight mountImageLayer fetch/decode can be
    // dropped on effect re-run. Previously the mounts were sequential and
    // ran without cancellation; a re-run while the candidate fetch was
    // still pending would let the OLD candidate sprite eventually attach
    // to the destroyed candidateApp (silently orphaned), and the candidate
    // pane would render empty even though the NEW effect ran cleanly.
    const ac = new AbortController();
    let baselineRO: ResizeObserver | null = null;
    let candidateRO: ResizeObserver | null = null;
    let detachBaselineCtrl: (() => void) | null = null;
    let detachCandidateCtrl: (() => void) | null = null;

    (async () => {
      const baselineSize = hostSize(baselineRef.current);
      const candidateSize = hostSize(candidateRef.current);
      await baselineApp.init({
        width: baselineSize.w,
        height: baselineSize.h,
        backgroundColor: 0xf3f4f6, // slate-100; lets letterbox bands read as "outside the image"
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });
      await candidateApp.init({
        width: candidateSize.w,
        height: candidateSize.h,
        backgroundColor: 0xf3f4f6,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });
      if (cancelled) return;
      baselineRef.current?.appendChild(baselineApp.canvas);
      candidateRef.current?.appendChild(candidateApp.canvas);
      // World containers — sprite + overlays parent into these so the
      // fit/zoom/pan transform applies uniformly to the whole scene.
      const baselineWorld = new Container();
      const candidateWorld = new Container();
      baselineApp.stage.addChild(baselineWorld);
      candidateApp.stage.addChild(candidateWorld);

      // Parallelize: a slow baseline fetch must not block the candidate
      // pane from rendering. Promise.all keeps both panes symmetric on
      // re-run (abort cancels both at once instead of one mid-attach).
      const [baselineSprite, candidateSprite] = await Promise.all([
        baselineUrl
          ? mountImageLayer(baselineWorld, baselineUrl, ac.signal)
          : Promise.resolve(null),
        candidateUrl
          ? mountImageLayer(candidateWorld, candidateUrl, ac.signal)
          : Promise.resolve(null),
      ]);
      if (cancelled) return;
      baselineSpriteRef.current = baselineSprite;
      candidateSpriteRef.current = candidateSprite;
      // Fit each pane to its canvas. If the sprite never loaded (e.g. no
      // baseline yet, first-ever run), the world stays at identity and
      // the canvas shows just the slate-100 background.
      // Read zoom + pan from the store at mount time so the initial fit
      // already reflects any persisted view (e.g. user hit "0" mid-load).
      const view = (() => {
        const s = useViewerStore.getState();
        return { zoom: s.zoom, panX: s.panX, panY: s.panY };
      })();
      if (baselineSprite) {
        fitWorldToCanvas(
          baselineApp,
          baselineWorld,
          baselineSprite.texture.width,
          baselineSprite.texture.height,
          view,
        );
      }
      if (candidateSprite) {
        fitWorldToCanvas(
          candidateApp,
          candidateWorld,
          candidateSprite.texture.width,
          candidateSprite.texture.height,
          view,
        );
      }
      // IgnoreRegionLayer + drag overlay use these refs — set them last so
      // the layer doesn't briefly render on an unfit world.
      baselineWorldRef.current = baselineWorld;
      candidateWorldRef.current = candidateWorld;
      candidateAppRef.current = candidateApp;
      baselineAppRef.current = baselineApp;
      // Notify the shading effect that a fresh canvas is ready. Refs don't
      // trigger React effects, so we bump an epoch counter to signal the
      // shading effect to (re)mount the overlay on this new world.
      setCanvasEpoch((e) => e + 1);
      // Zoom/pan listeners on each pane host (not the canvas itself) so
      // events from the ignore-region overlay div — a sibling of the
      // canvas — also bubble to these handlers. Wheel zooms about cursor;
      // middle-mouse (or plain primary when not editing) pans. Detach
      // tokens kept on the effect closure so cleanup is symmetric.
      if (baselineRef.current) {
        detachBaselineCtrl = attachCanvasViewControl(baselineRef.current);
      }
      if (candidateRef.current) {
        detachCandidateCtrl = attachCanvasViewControl(candidateRef.current);
      }

      // Refit on resize so the screenshot follows the viewport without
      // remounting the Pixi Application. ResizeObserver fires once on
      // first observation, which is fine — fit math is cheap.
      // Helper so the RO callbacks pick up the current zoom/pan rather
      // than the value captured at mount time.
      const currentView = () => {
        const s = useViewerStore.getState();
        return { zoom: s.zoom, panX: s.panX, panY: s.panY };
      };
      if (baselineRef.current) {
        baselineRO = new ResizeObserver(() => {
          if (cancelled || !baselineApp.renderer) return;
          const { w, h } = hostSize(baselineRef.current);
          baselineApp.renderer.resize(w, h);
          if (baselineSpriteRef.current) {
            fitWorldToCanvas(
              baselineApp,
              baselineWorld,
              baselineSpriteRef.current.texture.width,
              baselineSpriteRef.current.texture.height,
              currentView(),
            );
          }
        });
        baselineRO.observe(baselineRef.current);
      }
      if (candidateRef.current) {
        candidateRO = new ResizeObserver(() => {
          if (cancelled || !candidateApp.renderer) return;
          const { w, h } = hostSize(candidateRef.current);
          candidateApp.renderer.resize(w, h);
          if (candidateSpriteRef.current) {
            fitWorldToCanvas(
              candidateApp,
              candidateWorld,
              candidateSpriteRef.current.texture.width,
              candidateSpriteRef.current.texture.height,
              currentView(),
            );
          }
        });
        candidateRO.observe(candidateRef.current);
      }
    })().catch((err) => {
      // mountImageLayer's AbortError on effect re-run is expected; don't
      // log it. Real failures still surface.
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        console.warn("side-by-side mount failed", err);
      }
    });

    return () => {
      cancelled = true;
      ac.abort();
      baselineRO?.disconnect();
      candidateRO?.disconnect();
      detachBaselineCtrl?.();
      detachCandidateCtrl?.();
      // The shading effect handles its own cleanup via its own return fn.
      // Null the refs so in-flight shading mounts see an absent world.
      candidateAppRef.current = null;
      baselineAppRef.current = null;
      candidateWorldRef.current = null;
      baselineWorldRef.current = null;
      candidateSpriteRef.current = null;
      baselineSpriteRef.current = null;
      regionLayerRef.current = null;
      // Pixi 8 occasionally throws `_cancelResize is not a function` from
      // the cascading texture-destroy path when an effect re-runs (e.g.
      // regions land via tRPC) before the previous Application has fully
      // initialized. The error was masked before ImageLayer was rewritten
      // because the load itself failed and no sprites were ever attached,
      // so cleanup was a no-op. Now that images mount cleanly, the unsafe
      // destroy reaches the bug — and an uncaught throw in a useEffect
      // cleanup escalates to a client-side exception that the Next error
      // boundary turns into "Application error: a client-side exception".
      // Catch + log: cleanup is best-effort; a leaked GPU texture on
      // route change is far cheaper than a blank error page.
      try {
        baselineApp.destroy(true, { children: true, texture: true });
      } catch (err) {
        console.warn("baseline Application.destroy threw (non-fatal)", err);
      }
      try {
        candidateApp.destroy(true, { children: true, texture: true });
      } catch (err) {
        console.warn("candidate Application.destroy threw (non-fatal)", err);
      }
    };
  }, [mode, baselineUrl, candidateUrl]);

  // Side-by-side shading layer: mounts / remounts the pink overlay whenever
  // overlay-specific props change (regions, selection, highlight, motion).
  // Reads world + app from refs so it never re-inits the canvas itself.
  // canvasEpoch bridges timing: the mount effect above bumps it once the
  // fresh world exists, triggering this effect to run on the new canvas.
  useEffect(() => {
    if (mode !== "side-by-side") return;
    const world = candidateWorldRef.current;
    const app = candidateAppRef.current;
    if (!world || !app) return;
    const shadingRegions = orderDiffRegions(regions);
    if (shadingRegions.length === 0) return;
    const layer = mountDiffShadingLayer(
      world,
      shadingRegions,
      selectedRegionId,
      {
        highlight: highlightActive,
        reducedMotion,
        ticker: app.ticker,
      },
    );
    shadingLayerRef.current = layer;
    return () => {
      layer.destroy();
      if (layer.container.parent)
        layer.container.parent.removeChild(layer.container);
      if (shadingLayerRef.current === layer) shadingLayerRef.current = null;
    };
  }, [
    canvasEpoch,
    mode,
    regions,
    selectedRegionId,
    highlightActive,
    reducedMotion,
  ]);

  // Single-stage modes.
  useEffect(() => {
    if (mode === "side-by-side") return;
    const app = new Application();
    let cancelled = false;
    const ac = new AbortController();
    let ro: ResizeObserver | null = null;
    let detachCtrl: (() => void) | null = null;

    (async () => {
      const size = hostSize(stageRef.current);
      await app.init({
        width: size.w,
        height: size.h,
        backgroundColor: 0xf3f4f6,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });
      if (cancelled) return;
      stageRef.current?.appendChild(app.canvas);
      const world = new Container();
      app.stage.addChild(world);

      // Parallelize the three loads — symmetric abort on re-run, no
      // sequential head-of-line blocking on a slow image.
      const [baselineSprite, candidateSprite, overlaySprite] =
        await Promise.all([
          baselineUrl
            ? mountImageLayer(world, baselineUrl, ac.signal)
            : Promise.resolve(null),
          candidateUrl
            ? mountImageLayer(world, candidateUrl, ac.signal)
            : Promise.resolve(null),
          mode === "difference" && diffOverlayUrl
            ? mountImageLayer(world, diffOverlayUrl, ac.signal)
            : Promise.resolve(null),
        ]);
      if (cancelled) return;
      baselineSpriteRef.current = baselineSprite;
      candidateSpriteRef.current = candidateSprite;
      // The stipple diff PNG is rendered at 60% alpha as subtle context.
      // The user-facing "what changed" signal is the bounded yellow
      // rectangles produced by `mountDiffOverlayLayer` below — those
      // come from the L1 pixel-cluster regions (engine.ts wiring,
      // `source: "l1_pixel"`) and read as Applitools-style highlights
      // on the candidate. The stipple sits underneath as fine detail.
      if (overlaySprite) overlaySprite.alpha = 0.6;
      // Fit using the candidate's natural size (falling back to baseline,
      // then overlay) so the world's coordinate system matches what the
      // user is reviewing. All three sprites mount at (0,0) and share
      // dimensions for any properly captured run.
      const fitSource = candidateSprite ?? baselineSprite ?? overlaySprite;
      const initialView = (() => {
        const s = useViewerStore.getState();
        return { zoom: s.zoom, panX: s.panX, panY: s.panY };
      })();
      if (fitSource) {
        fitWorldToCanvas(
          app,
          world,
          fitSource.texture.width,
          fitSource.texture.height,
          initialView,
        );
      }

      if (mode === "difference" && regions.length > 0) {
        mountDiffOverlayLayer(world, regions, selectedRegionId);
      }

      if (mode === "overlay" && candidateSpriteRef.current) {
        candidateSpriteRef.current.alpha = opacityRef.current;
      }
      // IgnoreRegionLayer + drag overlay use these refs — set them last
      // so the layer doesn't briefly render on an unfit world.
      singleWorldRef.current = world;
      singleAppRef.current = app;
      if (stageRef.current) {
        detachCtrl = attachCanvasViewControl(stageRef.current);
      }

      const currentView = () => {
        const s = useViewerStore.getState();
        return { zoom: s.zoom, panX: s.panX, panY: s.panY };
      };
      if (stageRef.current) {
        ro = new ResizeObserver(() => {
          if (cancelled || !app.renderer) return;
          const { w, h } = hostSize(stageRef.current);
          app.renderer.resize(w, h);
          const refit = candidateSpriteRef.current ?? baselineSpriteRef.current;
          if (refit) {
            fitWorldToCanvas(
              app,
              world,
              refit.texture.width,
              refit.texture.height,
              currentView(),
            );
          }
        });
        ro.observe(stageRef.current);
      }
    })().catch((err) => {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        console.warn("single-stage mount failed", err);
      }
    });

    return () => {
      cancelled = true;
      ac.abort();
      ro?.disconnect();
      detachCtrl?.();
      singleAppRef.current = null;
      singleWorldRef.current = null;
      candidateSpriteRef.current = null;
      baselineSpriteRef.current = null;
      regionLayerRef.current = null;
      // See side-by-side cleanup above for why destroy is wrapped — Pixi
      // 8's `_cancelResize` teardown path throws on rapid effect re-runs.
      try {
        app.destroy(true, { children: true, texture: true });
      } catch (err) {
        console.warn("single-stage Application.destroy threw (non-fatal)", err);
      }
    };
  }, [
    mode,
    baselineUrl,
    candidateUrl,
    diffOverlayUrl,
    regions,
    selectedRegionId,
  ]);

  // Live opacity update.
  useEffect(() => {
    if (mode !== "overlay") return;
    const candidate = candidateSpriteRef.current;
    if (!candidate) return;
    candidate.alpha = opacity;
  }, [mode, opacity]);

  // Reactive zoom + pan: re-apply the world transform on every store
  // change. Cheap (one matrix update per pane); refs that haven't been
  // populated yet are skipped by applyViewToPane.
  useEffect(() => {
    const view = { zoom, panX, panY };
    applyViewToPane(
      baselineAppRef.current,
      baselineWorldRef.current,
      baselineSpriteRef.current,
      view,
    );
    applyViewToPane(
      candidateAppRef.current,
      candidateWorldRef.current,
      candidateSpriteRef.current,
      view,
    );
    applyViewToPane(
      singleAppRef.current,
      singleWorldRef.current,
      candidateSpriteRef.current ?? baselineSpriteRef.current,
      view,
    );
  }, [zoom, panX, panY, mode, baselineUrl, candidateUrl, diffOverlayUrl]);

  useEffect(() => {
    if (!focusBbox) return;
    const app =
      mode === "side-by-side" ? candidateAppRef.current : singleAppRef.current;
    const sprite = candidateSpriteRef.current ?? baselineSpriteRef.current;
    if (!app || !sprite) return;
    const view = computeFocusView(
      focusBbox,
      sprite.texture.width,
      sprite.texture.height,
      app.screen.width,
      app.screen.height,
    );
    setView(view);
    setFocusBbox(null);
  }, [focusBbox, mode, setView, setFocusBbox]);

  // Remount the IgnoreRegionLayer whenever the store data or edit scope
  // changes. The layer is cheap to construct (one Graphics per region).
  useEffect(() => {
    const world =
      mode === "side-by-side"
        ? candidateWorldRef.current
        : singleWorldRef.current;
    if (!world) return;
    // Apply padding + kind overrides to saved regions before handing them
    // to the layer; the layer itself doesn't know about overrides. Drafts
    // mutate in place via setPaddingForSelected / setKindForSelected, so
    // they don't need this mapping.
    const applyOverrides = (r: IgnoreArea): IgnoreArea => {
      const kindOv = kindOverrides.get(r.id);
      return {
        ...r,
        paddingPx: paddingOverrides.get(r.id) ?? r.paddingPx,
        kind: kindOv?.kind ?? r.kind,
        pattern: kindOv ? kindOv.pattern : r.pattern,
      };
    };
    const savedRunWithOverrides = savedRunIgnoreAreas.map(applyOverrides);
    const savedVariationWithOverrides =
      savedVariationIgnoreAreas.map(applyOverrides);
    const layer = mountIgnoreRegionLayer(world, {
      editMode: ignoreEditMode,
      savedRunIgnoreAreas: savedRunWithOverrides,
      savedVariationIgnoreAreas: savedVariationWithOverrides,
      draftIgnoreAreas,
      markedForDeletion,
      selectedIgnoreId,
      viewport,
      onSelect: (id) => setSelectedIgnoreId(id),
      pickPreviewBbox:
        regionInputMode === "pick" && ignoreEditMode !== "off"
          ? pickPreview
          : null,
    });
    regionLayerRef.current = layer;
    return () => {
      layer.destroy({ children: true });
      if (regionLayerRef.current === layer) regionLayerRef.current = null;
    };
  }, [
    mode,
    ignoreEditMode,
    regionInputMode,
    pickPreview,
    savedRunIgnoreAreas,
    savedVariationIgnoreAreas,
    draftIgnoreAreas,
    markedForDeletion,
    paddingOverrides,
    kindOverrides,
    selectedIgnoreId,
    viewport,
    setSelectedIgnoreId,
  ]);

  // Drag-to-draw pointer overlay.
  const activeAppRef = mode === "side-by-side" ? candidateAppRef : singleAppRef;
  const activeWorldRef =
    mode === "side-by-side" ? candidateWorldRef : singleWorldRef;
  const toImage = useImageSpaceCoords({
    appRef: activeAppRef,
    worldRef: activeWorldRef,
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

  const pickModeActive =
    overlayActive && regionInputMode === "pick" && !!elementMap;

  // Click on the difference canvas (not the ignore-region overlay) to
  // select / deselect a diff region. Only active in difference mode;
  // other modes don't show the overlay so clicking there is a no-op for
  // region selection. Gated on primary button (button === 0) to avoid
  // clobbering middle-mouse pan and right-click context menu.
  const handleDiffRegionClick = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== "difference") return;
    if (e.button !== 0) return;
    const pt = toImage(e);
    if (!pt) return;
    const bboxRegions = regions.flatMap((r) => {
      if (
        !r.bbox ||
        typeof r.bbox !== "object" ||
        !("x" in r.bbox) ||
        !("y" in r.bbox) ||
        !("width" in r.bbox) ||
        !("height" in r.bbox)
      )
        return [];
      const bbox = r.bbox as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      return [{ id: r.id, ...bbox }];
    });
    const hit = hitTest(pt, bboxRegions);
    setSelected(hit);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayActive) return;
    // Non-primary buttons (middle = 1, right = 2) belong to the canvas
    // view-control listener (pan / context-menu suppression). Only
    // primary button is drag-draw.
    if (e.button !== 0) return;
    if (pickModeActive) return; // pick fires on pointerup, not down
    const pt = toImage(e);
    if (!pt) return;
    setDragStart(pt);
    setDragCurrent(pt);
    (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayActive) return;
    if (pickModeActive) {
      const pt = toImage(e);
      if (!pt) {
        if (pickPreview) setPickPreview(null);
        return;
      }
      const hit = findSmallestElementAtPoint(pt, elementMap.elements);
      // Only push state when the hovered bbox changes, to keep the
      // IgnoreRegionLayer remount effect from re-running on every
      // sub-pixel mouse step.
      if (!hit) {
        if (pickPreview) setPickPreview(null);
        return;
      }
      const same =
        pickPreview &&
        pickPreview.x === hit.bbox.x &&
        pickPreview.y === hit.bbox.y &&
        pickPreview.width === hit.bbox.width &&
        pickPreview.height === hit.bbox.height;
      if (!same) setPickPreview(hit.bbox);
      return;
    }
    if (!dragStart) return;
    const pt = toImage(e);
    if (!pt) return;
    setDragCurrent(pt);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!overlayActive) return;
    if (e.button !== 0) return;
    if (pickModeActive) {
      const pt = toImage(e);
      if (!pt) return;
      const hit = findSmallestElementAtPoint(pt, elementMap.elements);
      if (!hit) return; // click missed every element — no-op
      const draft: DraftIgnoreArea = {
        id: crypto.randomUUID(),
        x: hit.bbox.x,
        y: hit.bbox.y,
        width: hit.bbox.width,
        height: hit.bbox.height,
        viewport,
        paddingPx: 0,
        kind: "ignore",
        // Pre-set the selector so the region anchors to the element
        // immediately — the pick path is a stronger expression of
        // intent than the post-drag snap suggestion.
        selector: hit.selector,
      };
      addDraftRegion(draft);
      setPickPreview(null);
      return;
    }
    if (!dragStart) return;
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
    if (pickPreview) setPickPreview(null);
  };

  const handlePointerLeave = (_e: React.PointerEvent<HTMLDivElement>) => {
    if (pickPreview) setPickPreview(null);
  };

  // Container layout: the pane wrapper is given an explicit min height so
  // the Pixi canvas has a stable box to fill (and the ResizeObserver fires
  // on real layout changes, not on every parent re-render).
  if (mode === "side-by-side") {
    // Reference TestStep layout: a floating, uppercase label above each clean
    // shadowed card (no bordered box with an inset header bar). The card IS the
    // Pixi canvas host — rounded + overflow-hidden clips the canvas corners.
    return (
      <div className="flex min-h-full p-6">
        <div className="m-auto grid w-full grid-cols-2 items-start gap-6">
          <div className="flex flex-col gap-2">
            <div
              className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground shrink-0"
              title="Baseline"
              aria-label="Baseline"
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"
                aria-hidden
              />
              Baseline
            </div>
            <div
              ref={baselineRef}
              data-testid="baseline-canvas-host"
              style={aspectStyle(baselineDims)}
              className="relative w-full min-h-[200px] overflow-hidden rounded-lg border bg-zinc-50 shadow-lg dark:bg-zinc-900"
            >
              {!baselineUrl && (
                <CanvasEmptyState label="No baseline yet">
                  Approve this run to set its candidate as the first baseline
                  for this variation.
                </CanvasEmptyState>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div
              className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground shrink-0"
              title="Candidate"
              aria-label="Candidate"
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                aria-hidden
              />
              Current
            </div>
            <div
              ref={candidateRef}
              data-testid="candidate-canvas-host"
              style={aspectStyle(candidateDims)}
              className="relative w-full min-h-[200px] overflow-hidden rounded-lg border bg-zinc-50 shadow-lg dark:bg-zinc-900"
            >
              {!candidateUrl && (
                <CanvasEmptyState label="Waiting for capture…">
                  The SDK upload for this run hasn’t arrived yet. This panel
                  will fill in automatically when the screenshot lands.
                </CanvasEmptyState>
              )}
              {overlayActive && (
                <div
                  className={`absolute inset-0 ${
                    pickModeActive ? "cursor-pointer" : "cursor-crosshair"
                  }`}
                  data-testid="ignore-region-overlay"
                  data-input-mode={regionInputMode}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                  onPointerLeave={handlePointerLeave}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full p-6">
      <div
        style={aspectStyle(candidateDims ?? baselineDims)}
        className="relative m-auto w-full min-h-[200px] overflow-hidden rounded-lg border bg-zinc-50 shadow-lg dark:bg-zinc-900"
        ref={stageRef}
        data-testid="single-stage-host"
        data-mode={mode}
        onPointerUp={handleDiffRegionClick}
      >
        {!baselineUrl && !candidateUrl && (
          <CanvasEmptyState label="Nothing to compare yet">
            This run hasn’t been captured. As soon as the SDK uploads
            screenshots, the diff renders here.
          </CanvasEmptyState>
        )}
        {overlayActive && (
          <div
            className={`absolute inset-0 ${
              pickModeActive ? "cursor-pointer" : "cursor-crosshair"
            }`}
            data-testid="ignore-region-overlay"
            data-input-mode={regionInputMode}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={handlePointerLeave}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Centered placeholder shown when a canvas pane has no image to render.
 * Replaces the previous bare light-gray rectangle with explicit copy so
 * users know whether the run is in progress, empty, or pending capture.
 * Same visual treatment as `EmptyRunCard` to feel native to the viewer.
 */
function CanvasEmptyState({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center"
      data-testid="canvas-empty-state"
    >
      <div className="text-sm font-medium text-zinc-300">{label}</div>
      <div className="text-xs text-zinc-500 max-w-[26rem]">{children}</div>
    </div>
  );
}
