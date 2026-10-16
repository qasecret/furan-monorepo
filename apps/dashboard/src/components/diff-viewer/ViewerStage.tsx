"use client";

// Swap pixi's `new Function` shader/uniform code generation for its eval-free
// polyfills — the dashboard CSP (lib/csp.ts) forbids 'unsafe-eval', and without
// this pixi throws "Current environment does not allow unsafe-eval" on init.
import "pixi.js/unsafe-eval";
import { useTheme } from "next-themes";
import { Application, Container } from "pixi.js";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  applyCanvasBackground,
  FALLBACK_CANVAS_HATCH,
  readCanvasBackground,
  readCanvasHatch,
} from "./canvas-theme";
import { orderDiffRegions } from "./diff-order";
import type { ImageRole, ImageSetRequest, ImageSetState } from "./image-set";
import { mountDiffOverlayLayer } from "./layers/DiffOverlayLayer";
import { mountDiffShadingLayer } from "./layers/DiffShadingLayer";
import { mountIgnoreRegionLayer } from "./layers/IgnoreRegionLayer";
import type { DiffRegion } from "./layers/regionTypes";
import {
  RENDERERS,
  type HostLayer,
  type ModeHandle,
  type RenderInput,
} from "./modes/types";
import { pointerToImage } from "./pointer-to-image";
import { attachCanvasViewControl } from "./useCanvasViewControl";
import type { ElementMap } from "./useElementMap";
import { hitTest, useIgnoreRegionEditor } from "./useIgnoreRegionEditor";
import { useReducedMotion } from "./useReducedMotion";
import { useViewerStore, type IgnoreArea } from "./useViewerStore";
import { useViewState } from "./view-state";
import {
  transformFor,
  worldFor,
  type Size,
  type World,
} from "./viewer-geometry";
import { drawnMode, useViewerPrefs } from "./viewer-prefs";
import { computeFocusView } from "./world-fit";

/**
 * The diff viewer's canvas: one compositor for every comparison mode (spec
 * §3.3).
 *
 * - **Geometry.** Every image is placed in one world (`worldFor`: the union of
 *   the sizes, each image top-left at 1:1), fitted once and transformed once
 *   (`transformFor`). Every pane and every mode takes that one transform, so a
 *   mode change keeps the zoom and the pan (R8); only a step or a viewport
 *   change resets the view, and that is `DiffViewer`'s.
 * - **Images** come from `useImageSet` (the caller's): this never fetches,
 *   and never closes a bitmap.
 * - **Modes** are renderers (`modes/`) that build their own layers in a
 *   declared order. One mounts only when every image it needs has settled,
 *   so nothing lands on the stage as a fetch completes, and a step change
 *   clears the canvas until the new step's images are in.
 * - **The host's layers** (highlight shading, the severity rectangles, the
 *   ignore-region editor) are the existing ones, mounted here on the pane the
 *   renderer names and always stacked above its layers, in its order.
 * - **Pixi apps**: one per pane, kept across mode changes with the same pane
 *   count; zoom, pan, resizes and the theme update them in place.
 */

interface Props {
  /** The step's images, from `useImageSet`. */
  set: ImageSetState;
  /** The keys `set` was asked for: a role with no key has nothing to wait for. */
  request: ImageSetRequest;
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
}

/** The pixi apps for one pane layout, one world container in each. */
interface Stage {
  /** Its `generationRef` value; once that moves on, the stage is going. */
  generation: number;
  panes: number;
  apps: Application[];
  worlds: Container[];
}

/** Fallback dimensions used before the host element has been laid out. */
const FALLBACK_W = 800;
const FALLBACK_H = 600;

function hostSize(el: HTMLElement): Size {
  return { w: el.clientWidth || FALLBACK_W, h: el.clientHeight || FALLBACK_H };
}

/** Card aspect-ratio style from the world's size (none until it is known). */
function aspectStyle(size?: Size): React.CSSProperties | undefined {
  return size && size.w > 0 && size.h > 0
    ? { aspectRatio: `${size.w} / ${size.h}` }
    : undefined;
}

/**
 * Puts the host's layers back on top of `world`, bottom to top in `order`. A
 * layer that (re)mounts lands on top of everything, and a renderer that
 * mounts lands above the host's layers: either way this restores the
 * declared order, with the renderer's own layers below in theirs.
 */
function restack(world: Container, order: readonly HostLayer[]): void {
  for (const label of order) {
    const layer = world.children.find((c) => c.label === label);
    if (layer) world.addChild(layer);
  }
}

/** Teardown is best effort: a leaked GPU texture beats a thrown cleanup. */
function destroyQuietly(what: string, destroy: () => void): void {
  try {
    destroy();
  } catch (err) {
    console.warn(`${what} destroy threw (non-fatal)`, err);
  }
}

/**
 * Destroys an app and whatever is still in its stage. No texture options:
 * every renderer has destroyed its own textures by now, and a texture's
 * source holds a cached bitmap that is not the app's to end. (Pixi never
 * closes a bitmap either way; the image cache does.)
 */
function destroyApp(app: Application): void {
  destroyQuietly("viewer Application", () =>
    app.destroy(true, { children: true }),
  );
}

/**
 * Small inline "≠" badge marking an image that has differences. Lives in the
 * label row above the card (not over the image) so it never obscures content.
 */
function DiffBadge() {
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center rounded border border-edge-strong bg-raised text-2xs font-bold leading-none text-fg-secondary"
      data-testid="diff-badge"
      aria-label="Has differences"
      title="This image has differences"
    >
      ≠
    </span>
  );
}

export function ViewerStage({ set, request, regions, elementMap }: Props) {
  const paneARef = useRef<HTMLDivElement>(null);
  const paneBRef = useRef<HTMLDivElement>(null);
  const singleRef = useRef<HTMLDivElement>(null);
  // Every initialised app, so a theme change can repaint the letterbox
  // without tearing the canvas down.
  const liveAppsRef = useRef<Application[]>([]);
  // Moves on whenever a stage is made or torn down: an init that finishes
  // for a stage no longer wanted is dropped, and nothing mounts on it.
  const generationRef = useRef(0);
  const handleRef = useRef<ModeHandle | null>(null);
  // The world's size for the wheel's zoom-about-the-cursor.
  const worldSizeRef = useRef<Size>({ w: 0, h: 0 });
  const { resolvedTheme } = useTheme();

  const mode = useViewerPrefs((s) => s.prefs.mode);
  const shown = drawnMode(mode);
  const renderer = RENDERERS[mode];
  const opacity = useViewerPrefs((s) => s.prefs.opacity);
  const highlight = useViewerPrefs((s) => s.prefs.highlight);
  // "Hide displacement" also drops position-only (layout) regions from the
  // canvas shading — not just the diff-stepper — so toggling it is visible.
  const hideDisplacement = useViewerPrefs((s) => s.prefs.hideDisplacement);
  const reducedMotion = useReducedMotion();
  const zoom = useViewState((s) => s.zoom);
  const panX = useViewState((s) => s.panX);
  const panY = useViewState((s) => s.panY);
  const swipe = useViewState((s) => s.swipe);
  const flickerFrame = useViewState((s) => s.flickerFrame);
  const focusBbox = useViewState((s) => s.focusBbox);
  const setView = useViewState((s) => s.setView);
  const setFocusBbox = useViewState((s) => s.setFocusBbox);
  const selectedRegionId = useViewState((s) => s.selectedRegionId);
  const setSelected = useViewState((s) => s.setSelected);

  // Ignore-region store slices, for the editor's layer.
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
  const geometryOverrides = useViewerStore((s) => s.geometryOverrides);
  const viewport = useViewerStore((s) => s.viewport);
  const regionInputMode = useViewerStore((s) => s.regionInputMode);
  const setSelectedIgnoreId = useViewerStore((s) => s.setSelectedIgnoreId);

  const [stage, setStage] = useState<Stage | null>(null);
  // Each pane host's size, in the stage's pane order.
  const [hostSizes, setHostSizes] = useState<Size[]>([]);
  const [hatchColor, setHatchColor] = useState(() =>
    typeof document === "undefined" ? FALLBACK_CANVAS_HATCH : readCanvasHatch(),
  );

  const { images, failed } = set;
  const hasBaseline = request.baseline !== null;

  // One world for every mode: every image that has loaded takes part, drawn
  // or not, so each mode shows the same world under the same transform.
  const baselineSize = images.baseline?.size;
  const currentSize = images.current?.size;
  const diffSize = images.diff?.size;
  const world = useMemo<World | null>(() => {
    const anchor = currentSize ?? baselineSize ?? diffSize;
    if (!anchor) return null;
    return worldFor(baselineSize ?? null, anchor, diffSize ?? null);
  }, [baselineSize, currentSize, diffSize]);

  // The renderer waits for what it needs: each role it draws has loaded,
  // failed, or was never asked for.
  const needs = renderer.needs({ hasBaseline });
  const settled = needs.every(
    (role) =>
      request[role] === null ||
      images[role] !== undefined ||
      failed[role] === true,
  );
  const drawn = (role: ImageRole) =>
    needs.includes(role) ? images[role]?.bitmap : undefined;
  const baselineBitmap = drawn("baseline");
  const currentBitmap = drawn("current");
  const diffBitmap = drawn("diff");

  const panes = renderer.panes;
  // The stage when it fits the renderer; one for another pane count is going.
  const live = stage !== null && stage.panes === panes ? stage : null;
  const viewportSize = live ? (hostSizes[renderer.host.pane] ?? null) : null;
  const transform = useMemo(
    () =>
      world && viewportSize
        ? transformFor(world.size, viewportSize, { zoom, panX, panY })
        : null,
    [world, viewportSize, zoom, panX, panY],
  );
  const scale = transform?.scale ?? 1;

  // Where the host draws its layers, once the renderer is on the stage.
  const sceneReady = live !== null && settled && world !== null;
  const hostWorld = sceneReady
    ? (live.worlds[renderer.host.pane] ?? null)
    : null;
  const hostApp = sceneReady ? (live.apps[renderer.host.pane] ?? null) : null;
  const hostLayers = renderer.host.layers;

  const input = useMemo<RenderInput | null>(
    () =>
      world
        ? {
            world,
            images: {
              baseline: images.baseline?.bitmap,
              current: images.current?.bitmap,
              diff: images.diff?.bitmap,
            },
            opacity,
            swipe,
            flickerFrame,
            colors: { hatch: hatchColor },
          }
        : null,
    [world, images, opacity, swipe, flickerFrame, hatchColor],
  );
  const hasInput = input !== null;

  // The pixi apps: one per pane, made when the pane count changes and kept
  // across every other change.
  useEffect(() => {
    const hosts = (
      panes === 2 ? [paneARef.current, paneBRef.current] : [singleRef.current]
    ).filter((h): h is HTMLDivElement => h !== null);
    if (hosts.length !== panes) return;
    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    const apps = hosts.map(() => new Application());
    const ready = Promise.all(
      apps.map((app, i) => {
        const size = hostSize(hosts[i]!);
        return app.init({
          width: size.w,
          height: size.h,
          backgroundColor: readCanvasBackground(), // --hover; lets letterbox bands read as "outside the image"
          antialias: true,
          autoDensity: true,
          resolution: window.devicePixelRatio || 1,
        });
      }),
    );
    const detach: Array<() => void> = [];

    ready
      .then(() => {
        if (!isCurrent()) return;
        liveAppsRef.current.push(...apps);
        // The theme may have flipped while the apps were initialising.
        applyCanvasBackground(apps, readCanvasBackground());
        const worlds = apps.map((app, i) => {
          hosts[i]!.appendChild(app.canvas);
          // Every layer parents into the world, so one transform places all.
          const world = new Container();
          world.label = "world";
          app.stage.addChild(world);
          return world;
        });
        hosts.forEach((host, i) => {
          // Wheel zoom and pan on the host, not the canvas, so events from
          // the editor overlay (a sibling of the canvas) reach them too.
          detach.push(
            attachCanvasViewControl(host, () => worldSizeRef.current),
          );
          // Follow the host's size without remounting.
          const ro = new ResizeObserver(() => {
            const app = apps[i]!;
            if (!isCurrent() || !app.renderer) return;
            const size = hostSize(host);
            app.renderer.resize(size.w, size.h);
            setHostSizes((sizes) => {
              const next = sizes.slice();
              next[i] = size;
              return next;
            });
          });
          ro.observe(host);
          detach.push(() => ro.disconnect());
        });
        setHostSizes(hosts.map(hostSize));
        setStage({ generation, panes, apps, worlds });
      })
      .catch((err) => {
        console.warn("viewer stage init failed", err);
      });

    return () => {
      if (isCurrent()) generationRef.current += 1;
      for (const off of detach) off();
      liveAppsRef.current = liveAppsRef.current.filter(
        (a) => !apps.includes(a),
      );
      setStage(null);
      // Destroyed once init has settled (destroying an app mid-init leaks the
      // renderer it is still building), and so after every effect cleanup of
      // this commit: the renderer and the host's layers are gone by then.
      const destroy = () => apps.forEach(destroyApp);
      void ready.then(destroy, destroy);
    };
  }, [panes]);

  // The mode's renderer. It mounts once what it needs has settled, and again
  // only for a new stage, a new renderer or new images to draw; everything
  // else reaches it through `update`.
  useEffect(() => {
    if (!stage || stage.generation !== generationRef.current) return;
    if (stage.panes !== renderer.panes || !settled || !input) return;
    const handle = renderer.mount(stage.worlds, input);
    handleRef.current = handle;
    const hostPane = stage.worlds[renderer.host.pane];
    if (hostPane) restack(hostPane, renderer.host.layers);
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      handle.dispose();
    };
    // `input` is read as of the mount; its later changes go through `update`.
  }, [
    stage,
    renderer,
    settled,
    baselineBitmap,
    currentBitmap,
    diffBitmap,
    hasInput,
  ]);

  useEffect(() => {
    if (input) handleRef.current?.update(input);
  }, [input]);

  // One transform for every pane: fit, zoom and pan of the world.
  useEffect(() => {
    worldSizeRef.current = world?.size ?? { w: 0, h: 0 };
    if (!stage || stage.generation !== generationRef.current || !transform) {
      return;
    }
    for (const w of stage.worlds) {
      w.scale.set(transform.scale);
      w.position.set(transform.x, transform.y);
    }
  }, [stage, world, transform]);

  // Repaint the canvas colours when the theme flips (pixi can't read CSS
  // variables). next-themes applies the html class in the PROVIDER's effect,
  // which runs after this (child) effect in the same commit — so read the
  // tokens one microtask later, once the new class is on <html>.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      applyCanvasBackground(liveAppsRef.current, readCanvasBackground());
      setHatchColor(readCanvasHatch());
    });
    return () => {
      cancelled = true;
    };
  }, [resolvedTheme]);

  // The diff stepper asks for a region to be framed; frame it, then clear it.
  useEffect(() => {
    if (!focusBbox || !world || !viewportSize) return;
    setView(
      computeFocusView(
        focusBbox,
        world.size.w,
        world.size.h,
        viewportSize.w,
        viewportSize.h,
      ),
    );
    setFocusBbox(null);
  }, [focusBbox, world, viewportSize, setView, setFocusBbox]);

  // Highlight shading (H): the pink overlay, only with highlight on.
  const showShading =
    hostWorld !== null && hostLayers.includes("shading") && highlight;
  useEffect(() => {
    if (!showShading || !hostWorld || !hostApp) return;
    const shadingRegions = orderDiffRegions(regions, { hideDisplacement });
    if (shadingRegions.length === 0) return;
    const layer = mountDiffShadingLayer(
      hostWorld,
      shadingRegions,
      selectedRegionId,
      { highlight, reducedMotion, ticker: hostApp.ticker },
    );
    layer.container.label = "shading";
    restack(hostWorld, hostLayers);
    return () => {
      layer.destroy();
      destroyQuietly("shading layer", () =>
        layer.container.destroy({ children: true }),
      );
    };
  }, [
    showShading,
    hostWorld,
    hostApp,
    hostLayers,
    regions,
    selectedRegionId,
    highlight,
    hideDisplacement,
    reducedMotion,
  ]);

  // The severity rectangles.
  const showRegions =
    hostWorld !== null && hostLayers.includes("regions") && regions.length > 0;
  useEffect(() => {
    if (!showRegions || !hostWorld) return;
    const layer = mountDiffOverlayLayer(hostWorld, regions, selectedRegionId);
    layer.label = "regions";
    restack(hostWorld, hostLayers);
    return () => {
      destroyQuietly("regions layer", () => layer.destroy({ children: true }));
    };
  }, [showRegions, hostWorld, hostLayers, regions, selectedRegionId]);

  // The current image's pixel under a pointer on the host pane: the editor
  // always draws on the current image.
  const toImage = (e: { clientX: number; clientY: number }) => {
    const canvas = hostApp?.canvas;
    if (!canvas || !transform || !currentSize) return null;
    return pointerToImage(
      e,
      canvas.getBoundingClientRect(),
      transform,
      currentSize,
    );
  };
  const editor = useIgnoreRegionEditor({
    toImage,
    scale,
    bounds: currentSize ?? null,
    elementMap,
  });
  const { overlayActive, pickModeActive, pickPreview, hoverCursor } = editor;

  // The ignore-region editor's layer: remounted whenever the store data or
  // the edit scope changes (it is cheap: one Graphics per region), and on
  // zoom, so its handles stay a constant screen size.
  const showIgnore =
    hostWorld !== null && hostLayers.includes("ignore") && overlayActive;
  useEffect(() => {
    if (!showIgnore || !hostWorld) return;
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
    const layer = mountIgnoreRegionLayer(hostWorld, {
      editMode: ignoreEditMode,
      savedRunIgnoreAreas: savedRunIgnoreAreas.map(applyOverrides),
      savedVariationIgnoreAreas: savedVariationIgnoreAreas.map(applyOverrides),
      draftIgnoreAreas,
      markedForDeletion,
      selectedIgnoreId,
      geometryOverrides,
      scale,
      viewport,
      onSelect: (id) => setSelectedIgnoreId(id),
      pickPreviewBbox: regionInputMode === "pick" ? pickPreview : null,
    });
    layer.label = "ignore";
    restack(hostWorld, hostLayers);
    return () => {
      destroyQuietly("ignore layer", () => layer.destroy({ children: true }));
    };
  }, [
    showIgnore,
    hostWorld,
    hostLayers,
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
    geometryOverrides,
    scale,
    viewport,
    setSelectedIgnoreId,
  ]);

  // Click on the diff canvas (not the ignore-region overlay) to
  // select / deselect a diff region. Only active in diff mode.
  // Gated on primary button (button === 0) to avoid clobbering
  // middle-mouse pan and right-click context menu.
  const handleDiffRegionClick = (e: React.PointerEvent<HTMLDivElement>) => {
    if (shown !== "diff") return;
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
    setSelected(hitTest(pt, bboxRegions));
  };

  const editorOverlay = overlayActive && (
    <div
      className={`absolute inset-0 ${
        pickModeActive ? "cursor-pointer" : "cursor-crosshair"
      }`}
      style={{ cursor: hoverCursor ?? undefined }}
      data-testid="ignore-region-overlay"
      data-input-mode={regionInputMode}
      {...editor.handlers}
    />
  );

  // Container layout: the pane wrapper is given an explicit min height so
  // the Pixi canvas has a stable box to fill (and the ResizeObserver fires
  // on real layout changes, not on every parent re-render). Each card takes
  // the world's aspect ratio: side by side, both panes are the same box,
  // so the one transform places the world identically in both.
  if (panes === 2) {
    // Reference TestStep layout: a floating, uppercase label above each clean
    // shadowed card (no bordered box with an inset header bar). The card IS the
    // Pixi canvas host — rounded + overflow-hidden clips the canvas corners.
    return (
      <div className="flex min-h-full p-6">
        <div className="m-auto grid w-full grid-cols-2 items-start gap-6">
          <div className="flex flex-col gap-2">
            <div
              className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-muted shrink-0"
              title="Baseline"
              aria-label="Baseline"
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0"
                aria-hidden
              />
              Baseline
              {regions.length > 0 && <DiffBadge />}
            </div>
            <div
              ref={paneARef}
              data-testid="baseline-canvas-host"
              style={aspectStyle(world?.size)}
              className="relative w-full min-h-[200px] overflow-hidden rounded-lg bg-hover shadow-raised"
            >
              {request.baseline === null && (
                <CanvasEmptyState label="No baseline yet">
                  Approve this run to set its candidate as the first baseline
                  for this variation.
                </CanvasEmptyState>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div
              className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-muted shrink-0"
              title="Candidate"
              aria-label="Candidate"
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                aria-hidden
              />
              Current
              {regions.length > 0 && <DiffBadge />}
            </div>
            <div
              ref={paneBRef}
              data-testid="candidate-canvas-host"
              style={aspectStyle(world?.size)}
              className="relative w-full min-h-[200px] overflow-hidden rounded-lg bg-hover shadow-raised"
            >
              {request.current === null && (
                <CanvasEmptyState label="Waiting for capture…">
                  The SDK upload for this run hasn’t arrived yet. This panel
                  will fill in automatically when the screenshot lands.
                </CanvasEmptyState>
              )}
              {editorOverlay}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full p-6">
      <div
        style={aspectStyle(world?.size)}
        className="relative m-auto w-full min-h-[200px] overflow-hidden rounded-lg bg-hover shadow-raised"
        ref={singleRef}
        data-testid="single-stage-host"
        data-mode={shown}
        onPointerUp={handleDiffRegionClick}
      >
        {request.baseline === null && request.current === null && (
          <CanvasEmptyState label="Nothing to compare yet">
            This run hasn’t been captured. As soon as the SDK uploads
            screenshots, the diff renders here.
          </CanvasEmptyState>
        )}
        {editorOverlay}
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
      <div className="text-sm font-medium text-fg-secondary">{label}</div>
      <div className="text-xs text-fg-muted max-w-[26rem]">{children}</div>
    </div>
  );
}
