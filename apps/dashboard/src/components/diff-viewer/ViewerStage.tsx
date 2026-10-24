"use client";

// Swap pixi's `new Function` shader/uniform code generation for its eval-free
// polyfills — the dashboard CSP (lib/csp.ts) forbids 'unsafe-eval', and without
// this pixi throws "Current environment does not allow unsafe-eval" on init.
import "pixi.js/unsafe-eval";
import { useTheme } from "next-themes";
import { Application, Container, Sprite } from "pixi.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  applyCanvasBackground,
  FALLBACK_CANVAS_DIVIDER,
  FALLBACK_CANVAS_HATCH,
  readCanvasBackground,
  readCanvasDivider,
  readCanvasHatch,
} from "./canvas-theme";
import { CanvasModeLabel } from "./CanvasModeLabel";
import { orderDiffRegions } from "./diff-order";
import { FlickerAnnouncer, useFlickerTimer } from "./FlickerControls";
import {
  IMAGE_ROLES,
  retainImages,
  type ImageRole,
  type ImageSetRequest,
  type ImageSetState,
} from "./image-set";
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
import { isPixelDiffRegion, isRegionShown } from "./region-visibility";
import {
  HatchTooltips,
  readMaxTextureSize,
  stageStates,
  StageStates,
  statesForPane,
} from "./StageStates";
import { SwipeHandle } from "./SwipeHandle";
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
  type Transform,
  type World,
} from "./viewer-geometry";
import { useEffectiveMode } from "./viewer-mode";
import { useViewerPrefs } from "./viewer-prefs";
import { computeFocusView } from "./world-fit";

import type { DiffErrorCode } from "@/lib/diff-error-copy";

/**
 * The diff viewer's canvas: one compositor for every comparison mode (spec
 * §3.3).
 *
 * - **Geometry.** Every image is placed in one world (`worldFor`: the union of
 *   the sizes, each image top-left at 1:1), fitted once and transformed once
 *   (`transformFor`). Every pane and every mode takes that one transform. The
 *   pan is in world px (R12), so a mode change (a pane of another size) or a
 *   resize keeps the area on screen (R8); only a step or a viewport change
 *   resets the view, and that is `DiffViewer`'s.
 * - **Images** come from `useImageSet` (the caller's): this never fetches,
 *   and never closes a bitmap. It pins what it has mounted until its own
 *   cleanup, so no one else's release can close a bitmap it still draws.
 * - **Modes** are renderers (`modes/`) that build their own layers in a
 *   declared order. One mounts only when every image it needs has settled,
 *   so nothing lands on the stage as a fetch completes, and a step change
 *   clears the canvas until the new step's images are in. A retry keeps what
 *   is mounted until the retried image settles.
 * - **The host's layers** (highlight shading, the severity rectangles, the
 *   ignore regions) are the existing ones, mounted here on the pane the
 *   renderer names and always stacked above its layers, in its order. Saved
 *   ignore regions show read-only in every mode that draws the current image
 *   (R9); the editor only makes them interactive. Every region surface uses
 *   the region list's visibility (R10). The severity rectangles are filled
 *   only in Diff; elsewhere they are outlines, so the pixels compared stay
 *   true (R28).
 * - **Pixi apps**: one per pane, kept across mode changes with the same pane
 *   count; zoom, pan, resizes and the theme update them in place, and a
 *   resize refits before the next paint.
 * - **Swipe's handle** is DOM over the stage (`SwipeHandle`), in % of it like
 *   the canvas's divider, which is a fraction of the canvas: a resize keeps
 *   both at their fraction, and the observer moves the divider at once.
 * - **Flicker** swaps its frames on its clock (`useFlickerTimer`), which runs
 *   only once both frames are on the stage, so the first frame drawn is the
 *   baseline. A swap reaches the renderer as an update, never a remount, and
 *   both images are on the GPU from the mount. A polite live region, kept
 *   mounted across layouts, says a swap by hand.
 * - **A label on each card** (`CanvasModeLabel`, R18) names what it shows,
 *   in every mode: overlaid on its top-left, out of the layout, so no mode
 *   moves a card for it. In Flicker it names the frame on screen.
 * - **What it can't show** it says, in DOM over the canvas (`StageStates`,
 *   spec §3.4): an image loading or failed (with Retry), no baseline, a diff
 *   that failed for good (with Retry diff), and in Diff the reasons there is
 *   no diff image. Without a baseline only side by side is available, so a
 *   chosen mode that needs one (stored, or the URL's) draws as side by side
 *   and is kept (R2). A screenshot larger than the GPU's textures is never
 *   mounted. The hatching's tooltips are DOM hit areas over the strips.
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
  /**
   * The step should have had a diff image of its own and lost it to history
   * (`stepDiffKey`): Diff says so when the step has a diff.
   */
  legacyMissing?: boolean;
  /**
   * R4: the step has a pixel diff (a pixel-diff region, or a diff percent
   * above 0). Defaults to whether `regions` has a pixel-diff region.
   */
  stepHasDiff?: boolean;
  /**
   * R52: the step has no verdict yet, so Diff says nothing about its changes
   * or its diff image.
   */
  awaitingDiff?: boolean;
  /**
   * The active step's checkpoint id. Once the step's images are on the stage
   * and a frame has gone by, the stage root carries it as `data-stage-drawn`
   * (a test hook, see the effect below). Absent while the step is not known.
   */
  checkpointId?: string;
  /**
   * The step's diff failed for good, and why (`diffFailedAt`, `diffError`).
   * The stage says so, in place of the messages about a missing diff.
   */
  diffFailed?: DiffErrorCode | null;
  /** Retry the failed diff; absent for a viewer who may not. */
  onRetryDiff?: () => void;
  /** The retry of the failed diff is out. */
  retryingDiff?: boolean;
}

/** The pixi apps for one pane layout, one world container in each. */
interface Stage {
  /** Its `generationRef` value; once that moves on, the stage is going. */
  generation: number;
  panes: number;
  apps: Application[];
  worlds: Container[];
}

const NO_KEYS: ReadonlySet<string> = new Set();

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

/** Places every pane's world under the one transform. */
function placeWorlds(worlds: readonly Container[], t: Transform): void {
  for (const w of worlds) {
    w.scale.set(t.scale);
    w.position.set(t.x, t.y);
  }
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

/**
 * Puts every image under `node` on `app`'s GPU now, the hidden ones too
 * (Flicker's other frame), as pixi's prepare system does: a swap never stalls
 * on uploading a large screenshot. Best effort: an image not uploaded here is
 * uploaded when it is first drawn.
 */
function uploadImages(app: Application, node: Container): void {
  for (const child of node.children) {
    if (child instanceof Sprite) {
      try {
        app.renderer.texture.initSource(child.texture.source);
      } catch {
        // Uploaded at its first draw instead.
      }
    }
    uploadImages(app, child);
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
 * Small inline "≠" badge marking an image that has differences, in side by
 * side's labels on the canvas. An image, so its name is spoken (a name on a
 * generic span is not). The label it sits in lets the pointer through to the
 * canvas; the badge alone takes it, so its hover text shows (T12 M2).
 */
function DiffBadge() {
  return (
    <span
      role="img"
      className="pointer-events-auto inline-flex h-4 w-4 items-center justify-center rounded border border-edge-strong bg-raised text-2xs font-bold leading-none text-fg-secondary"
      data-testid="diff-badge"
      aria-label="Has differences"
      title="This image has differences"
    >
      ≠
    </span>
  );
}

export function ViewerStage({
  set,
  request,
  regions,
  elementMap,
  legacyMissing = false,
  stepHasDiff = regions.some(isPixelDiffRegion),
  awaitingDiff = false,
  checkpointId,
  diffFailed = null,
  onRetryDiff,
  retryingDiff = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
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
  // What the stage's DOM callbacks (resize, wheel, drag) read between
  // renders: the world's size and the pane the transform is computed for.
  const sceneRef = useRef<{ world: Size | null; hostPane: number }>({
    world: null,
    hostPane: 0,
  });
  const { resolvedTheme } = useTheme();

  const hasBaseline = request.baseline !== null;
  // The viewer's one mode (`viewer-mode`): a mode the step can't show draws
  // as side by side, and the choice is kept.
  const mode = useEffectiveMode(hasBaseline);
  const renderer = RENDERERS[mode];
  const opacity = useViewerPrefs((s) => s.prefs.opacity);
  const highlight = useViewerPrefs((s) => s.prefs.highlight);
  // "Hide displacement" also drops position-only (layout) regions from the
  // canvas — not just the diff-stepper — so toggling it is visible.
  const hideDisplacement = useViewerPrefs((s) => s.prefs.hideDisplacement);
  const reducedMotion = useReducedMotion();
  const zoom = useViewState((s) => s.zoom);
  const panX = useViewState((s) => s.panX);
  const panY = useViewState((s) => s.panY);
  const swipe = useViewState((s) => s.swipe);
  const setSwipe = useViewState((s) => s.setSwipe);
  const flickerFrame = useViewState((s) => s.flickerFrame);
  const focusBbox = useViewState((s) => s.focusBbox);
  const setView = useViewState((s) => s.setView);
  const setFocusBbox = useViewState((s) => s.setFocusBbox);
  const selectedRegionId = useViewState((s) => s.selectedRegionId);
  const setSelected = useViewState((s) => s.setSelected);
  const showSuppressed = useViewState((s) => s.showSuppressed);

  // Ignore-region store slices, for the ignore regions' layer.
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
  // Each pane host's size, in the stage's pane order, for React's consumers
  // (the stage's own callbacks keep theirs).
  const [hostSizes, setHostSizes] = useState<Size[]>([]);
  const [hatchColor, setHatchColor] = useState(() =>
    typeof document === "undefined" ? FALLBACK_CANVAS_HATCH : readCanvasHatch(),
  );
  const [dividerColor, setDividerColor] = useState(() =>
    typeof document === "undefined"
      ? FALLBACK_CANVAS_DIVIDER
      : readCanvasDivider(),
  );
  // The GPU's largest texture side, read from the first stage's renderer and
  // kept across stages. Unknown until then: nothing can be drawn before it.
  const [maxTextureSize, setMaxTextureSize] = useState<number | null>(null);

  const { images, failed } = set;

  // The regions every surface shows: the list's visibility (R10).
  const shownRegions = useMemo(
    () =>
      regions.filter((r) =>
        isRegionShown(r, { showSuppressed, hideDisplacement }),
      ),
    [regions, showSuppressed, hideDisplacement],
  );

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

  // The renderer waits for what it needs: each role has loaded, failed, or
  // was never asked for.
  const needs = renderer.needs({ hasBaseline });
  const settled = needs.every(
    (role) =>
      request[role] === null ||
      images[role] !== undefined ||
      failed[role] === true,
  );
  // A retry puts a failed role back to loading: the images that were in are
  // still the step's, so what is mounted stays until the retry settles. Only
  // other keys (a step change) wait with an empty canvas.
  const needKey = needs.map((role) => request[role] ?? "").join("|");
  const [settledKey, setSettledKey] = useState<string | null>(null);
  useEffect(() => {
    // Keys that have not settled forget the ones that had: coming back to
    // those (a step and back before this one is in) waits for every image
    // again, and never mounts what happens to be there (NB1).
    setSettledKey((key) => (settled ? needKey : key === needKey ? key : null));
  }, [settled, needKey]);

  // The image keys whose Retry was pressed. While one is on its way again,
  // its card stays, busy, and keeps the keyboard's place (M2).
  const [retried, setRetried] = useState<ReadonlySet<string>>(NO_KEYS);
  const retryImage = set.retry;
  const onRetry = useCallback(
    (role: ImageRole) => {
      const key = request[role];
      if (key !== null) setRetried((keys) => new Set(keys).add(key));
      retryImage(role);
    },
    [request, retryImage],
  );
  const retrying = IMAGE_ROLES.filter((role) => {
    const key = request[role];
    return (
      key !== null &&
      retried.has(key) &&
      images[role] === undefined &&
      !failed[role]
    );
  });
  const stillRetried = new Set(retrying.map((role) => request[role]!));
  // A retried image that has settled, or is no longer asked for, is let go.
  useEffect(() => {
    if (stillRetried.size < retried.size) setRetried(stillRetried);
  });

  const states = stageStates({
    mode,
    set,
    hasBaseline,
    legacyMissing,
    stepHasDiff,
    awaitingDiff,
    sizes: {
      baseline: images.baseline?.size,
      current: images.current?.size,
      diff: images.diff?.size,
    },
    maxTextureSize: maxTextureSize ?? Number.POSITIVE_INFINITY,
    retrying,
    diffFailed,
  });
  const loading = states.some((s) => s.kind === "loading");
  // An image the GPU can't hold would draw as nothing, or as garbage: it is
  // left out, and the renderer draws around it, as around a failed one (I2).
  // Its size still makes the world.
  const fits = (role: ImageRole) =>
    !states.some((s) => s.kind === "too-large" && s.role === role);
  const baselineFits = fits("baseline");
  const currentFits = fits("current");
  const diffFits = fits("diff");
  // Nothing the mode draws can go on a texture: nothing mounts.
  const blocked =
    !renderer.draws.every(fits) &&
    !renderer.draws.some((role) => images[role] !== undefined && fits(role));
  const ready = (settled || settledKey === needKey) && !blocked;
  const drawn = (role: ImageRole) =>
    needs.includes(role) && fits(role) ? images[role]?.bitmap : undefined;
  const baselineBitmap = drawn("baseline");
  const currentBitmap = drawn("current");
  const diffBitmap = drawn("diff");
  // The step is drawn when every image the mode draws and the step has is on
  // the stage: not while one is loading, failed, or too large for the GPU.
  const drawnRoles = renderer.draws.filter((role) => request[role] !== null);
  const stepDrawn =
    drawnRoles.length > 0 &&
    drawnRoles.every((role) => drawn(role) !== undefined);

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
  const sceneReady = live !== null && ready && world !== null;
  const hostWorld = sceneReady
    ? (live.worlds[renderer.host.pane] ?? null)
    : null;
  const hostApp = sceneReady ? (live.apps[renderer.host.pane] ?? null) : null;
  const hostLayers = renderer.host.layers;

  // Flicker's clock, once both its frames are on the stage.
  useFlickerTimer({
    active:
      mode === "flicker" &&
      sceneReady &&
      baselineBitmap !== undefined &&
      currentBitmap !== undefined,
    reducedMotion,
  });

  useLayoutEffect(() => {
    sceneRef.current = {
      world: world?.size ?? null,
      hostPane: renderer.host.pane,
    };
  });

  // What the renderer draws with, once the world is placed on a stage.
  const input = useMemo<RenderInput | null>(
    () =>
      world && transform && viewportSize
        ? {
            world,
            images: {
              baseline: baselineFits ? images.baseline?.bitmap : undefined,
              current: currentFits ? images.current?.bitmap : undefined,
              diff: diffFits ? images.diff?.bitmap : undefined,
            },
            opacity,
            swipe,
            flickerFrame,
            colors: { hatch: hatchColor, divider: dividerColor },
            transform,
            canvas: viewportSize,
          }
        : null,
    [
      world,
      images,
      baselineFits,
      currentFits,
      diffFits,
      opacity,
      swipe,
      flickerFrame,
      hatchColor,
      dividerColor,
      transform,
      viewportSize,
    ],
  );
  const hasInput = input !== null;
  // The input as last rendered, for the resize observer (see the stage).
  const inputRef = useRef<RenderInput | null>(null);
  useLayoutEffect(() => {
    inputRef.current = input;
  });

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
    // Every init settled, fulfilled or not: an app is destroyed only then
    // (destroying one mid-init leaks the renderer it is still building).
    const inits = Promise.allSettled(
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

    void inits.then((results) => {
      if (!isCurrent()) return;
      const failure = results.find((r) => r.status === "rejected");
      if (failure) {
        console.warn("viewer stage init failed", failure.reason);
        return;
      }
      liveAppsRef.current.push(...apps);
      setMaxTextureSize(readMaxTextureSize(apps[0]?.renderer));
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
      const sizes = hosts.map(hostSize);
      // The stage's world and the size its transform is computed for.
      const geometry = () => ({
        world: sceneRef.current.world ?? { w: 0, h: 0 },
        viewport: sizes[sceneRef.current.hostPane] ?? hostSize(hosts[0]!),
      });
      hosts.forEach((host, i) => {
        // Wheel zoom and pan on the host, not the canvas, so events from
        // the editor overlay (a sibling of the canvas) reach them too.
        detach.push(attachCanvasViewControl(host, geometry));
        // Follow the host's size without remounting, and refit at once: the
        // canvas paints at its new size this frame, so must the world.
        const ro = new ResizeObserver(() => {
          const app = apps[i]!;
          if (!isCurrent() || !app.renderer) return;
          const size = hostSize(host);
          app.renderer.resize(size.w, size.h);
          sizes[i] = size;
          const { world, hostPane } = sceneRef.current;
          if (i === hostPane && world) {
            const t = transformFor(world, size, useViewState.getState());
            placeWorlds(worlds, t);
            // What the renderer draws to the canvas's size (Swipe's divider,
            // the hatch's spacing) follows in the same frame.
            const last = inputRef.current;
            if (last) {
              handleRef.current?.update({
                ...last,
                transform: t,
                canvas: size,
              });
            }
          }
          setHostSizes(sizes.slice());
        });
        ro.observe(host);
        detach.push(() => ro.disconnect());
      });
      setHostSizes(sizes.slice());
      setStage({ generation, panes, apps, worlds });
    });

    return () => {
      if (isCurrent()) generationRef.current += 1;
      for (const off of detach) off();
      liveAppsRef.current = liveAppsRef.current.filter(
        (a) => !apps.includes(a),
      );
      setStage(null);
      // After every effect cleanup of this commit (a microtask at the
      // earliest): the renderer and the host's layers are gone by then.
      void inits.then(() => apps.forEach(destroyApp));
    };
  }, [panes]);

  // The mode's renderer. It mounts once what it needs is ready, and again
  // only for a new stage, a new renderer or new images to draw; everything
  // else reaches it through `update`. It pins what it mounts.
  useEffect(() => {
    if (!stage || stage.generation !== generationRef.current) return;
    if (stage.panes !== renderer.panes || !ready || !input) return;
    const release = retainImages(
      needs.flatMap((role) => {
        const key = images[role]?.key;
        return key === undefined ? [] : [key];
      }),
    );
    const handle = renderer.mount(stage.worlds, input);
    handleRef.current = handle;
    stage.worlds.forEach((world, i) => {
      const app = stage.apps[i];
      if (app) uploadImages(app, world);
    });
    const hostPane = stage.worlds[renderer.host.pane];
    if (hostPane) restack(hostPane, renderer.host.layers);
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      handle.dispose();
      // Only once the textures are gone may the cache close their bitmaps.
      release();
    };
    // `input` is read as of the mount; its later changes go through `update`.
  }, [
    stage,
    renderer,
    ready,
    baselineBitmap,
    currentBitmap,
    diffBitmap,
    hasInput,
  ]);

  // Test hook for the scale harness's browser suite, which times a step
  // change by waiting for this attribute: the stage root names the step
  // whose images the renderer has put on the stage, one frame after the
  // mount. It goes as soon as the step or the mode's input changes (this
  // cleanup runs before the mount effect's next run), so it never names a
  // step that is not on the stage. Set on the element, not through state:
  // no render depends on it. Declared after the mount effect, so it sees the
  // handle that effect made; `checkpointId` is a dependency here and not
  // there, as a step id arriving for the images already drawn must not mount
  // them again.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !checkpointId || !stepDrawn || handleRef.current === null) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      root.setAttribute("data-stage-drawn", checkpointId);
    });
    return () => {
      cancelAnimationFrame(frame);
      root.removeAttribute("data-stage-drawn");
    };
  }, [
    stage,
    renderer,
    ready,
    baselineBitmap,
    currentBitmap,
    diffBitmap,
    hasInput,
    stepDrawn,
    checkpointId,
  ]);

  useEffect(() => {
    if (input) handleRef.current?.update(input);
  }, [input]);

  // One transform for every pane: fit, zoom and pan of the world.
  useEffect(() => {
    if (!stage || stage.generation !== generationRef.current || !transform) {
      return;
    }
    placeWorlds(stage.worlds, transform);
  }, [stage, transform]);

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
      setDividerColor(readCanvasDivider());
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
    const shadingRegions = orderDiffRegions(regions, {
      hideDisplacement,
      showSuppressed,
    });
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
    showSuppressed,
    reducedMotion,
  ]);

  // The severity rectangles: filled in Diff, over its faded image; outlines
  // alone in every other mode, so the screenshots' pixels stay true (R28).
  const showRegions =
    hostWorld !== null &&
    hostLayers.includes("regions") &&
    shownRegions.length > 0;
  const regionFill = mode === "diff";
  useEffect(() => {
    if (!showRegions || !hostWorld) return;
    const layer = mountDiffOverlayLayer(
      hostWorld,
      shownRegions,
      selectedRegionId,
      { fill: regionFill },
    );
    layer.label = "regions";
    restack(hostWorld, hostLayers);
    return () => {
      destroyQuietly("regions layer", () => layer.destroy({ children: true }));
    };
  }, [
    showRegions,
    hostWorld,
    hostLayers,
    shownRegions,
    selectedRegionId,
    regionFill,
  ]);

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

  // The ignore regions, wherever the current image is drawn: read-only, and
  // interactive in the editor (R9). Remounted whenever the store data or the
  // edit scope changes (it is cheap: one Graphics per region), and on zoom,
  // so the editor's handles stay a constant screen size.
  const showIgnore = hostWorld !== null && hostLayers.includes("ignore");
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
      // A preview left from the editor (Esc while hovering) is not drawn.
      pickPreviewBbox:
        regionInputMode === "pick" && ignoreEditMode !== "off"
          ? pickPreview
          : null,
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
    if (mode !== "diff") return;
    if (e.button !== 0) return;
    const pt = toImage(e);
    if (!pt) return;
    const bboxRegions = shownRegions.flatMap((r) => {
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

  // The hatching's tooltips on pane `pane`, once its images are drawn, cut
  // to where the mode shows each image (Swipe's sides), for the image on
  // screen (Flicker's frame).
  const hatchTooltips = (pane: number) =>
    sceneReady && transform && viewportSize ? (
      <HatchTooltips
        world={world}
        images={(renderer.hatched({ flickerFrame })[pane] ?? []).filter(fits)}
        transform={transform}
        within={renderer.shownIn?.({
          world,
          transform,
          canvas: viewportSize,
          swipe,
        })}
      />
    ) : null;
  // Flicker's live region: the first child in either layout, so a layout
  // change keeps it mounted (and what appears in it announced).
  const flickerAnnouncer = <FlickerAnnouncer on={mode === "flicker"} />;
  // Where the focus goes when a focused Retry's card goes (M2), or Swipe's
  // focused handle (m1): its pane.
  const focusPane = (ref: React.RefObject<HTMLDivElement | null>) => () =>
    ref.current?.focus({ preventScroll: true });

  // Container layout: the pane wrapper is given an explicit min height so
  // the Pixi canvas has a stable box to fill (and the ResizeObserver fires
  // on real layout changes, not on every parent re-render). Each card takes
  // the world's aspect ratio: side by side, both panes are the same box,
  // so the one transform places the world identically in both. The states
  // sit over a card, outside it: the card's own listeners (pan) never see a
  // press on a Retry button.
  if (panes === 2) {
    // Reference TestStep layout: two clean shadowed cards. Each card IS the
    // Pixi canvas host (rounded + overflow-hidden clips the canvas corners),
    // named by its label on the canvas (R18).
    return (
      <div ref={rootRef} className="flex min-h-full p-6">
        {flickerAnnouncer}
        <div className="m-auto grid w-full grid-cols-2 items-start gap-6">
          <div className="relative">
            <div
              ref={paneARef}
              data-testid="baseline-canvas-host"
              tabIndex={-1}
              aria-busy={loading || undefined}
              style={aspectStyle(world?.size)}
              className="relative w-full min-h-[200px] overflow-hidden rounded-lg bg-hover shadow-raised focus-ring"
            >
              {hatchTooltips(0)}
            </div>
            <CanvasModeLabel
              mode={mode}
              pane="baseline"
              hasBaseline={hasBaseline}
            >
              {hasBaseline && shownRegions.length > 0 && <DiffBadge />}
            </CanvasModeLabel>
            <StageStates
              states={statesForPane(states, "baseline")}
              onRetry={onRetry}
              onFocusLost={focusPane(paneARef)}
            />
          </div>
          <div className="relative">
            <div
              ref={paneBRef}
              data-testid="candidate-canvas-host"
              tabIndex={-1}
              aria-busy={loading || undefined}
              style={aspectStyle(world?.size)}
              className="relative w-full min-h-[200px] overflow-hidden rounded-lg bg-hover shadow-raised focus-ring"
            >
              {request.current === null && (
                <CanvasEmptyState label="Waiting for capture…">
                  The SDK upload for this run hasn’t arrived yet. This panel
                  will fill in automatically when the screenshot lands.
                </CanvasEmptyState>
              )}
              {hatchTooltips(1)}
              {editorOverlay}
            </div>
            <CanvasModeLabel mode={mode} pane="current">
              {shownRegions.length > 0 && <DiffBadge />}
            </CanvasModeLabel>
            <StageStates
              states={statesForPane(states, "current")}
              onRetry={onRetry}
              onRetryDiff={onRetryDiff}
              retryingDiff={retryingDiff}
              onFocusLost={focusPane(paneBRef)}
            />
          </div>
        </div>
      </div>
    );
  }

  // The single stage clips (`overflow-clip`) rather than hiding its
  // overflow: a clip is no scroll container, so Swipe's handle can stick to
  // the viewer's scroll pane and stay on screen on a tall card (M1).
  return (
    <div ref={rootRef} className="flex min-h-full p-6">
      {flickerAnnouncer}
      <div className="relative m-auto w-full">
        <div
          style={aspectStyle(world?.size)}
          className="relative w-full min-h-[200px] overflow-clip rounded-lg bg-hover shadow-raised focus-ring"
          ref={singleRef}
          data-testid="single-stage-host"
          data-mode={mode}
          tabIndex={-1}
          aria-busy={loading || undefined}
          onPointerUp={handleDiffRegionClick}
        >
          {hatchTooltips(0)}
          {editorOverlay}
          {mode === "swipe" && sceneReady && (
            <SwipeHandle
              value={swipe}
              onChange={setSwipe}
              stageWidth={viewportSize?.w}
              onFocusLost={focusPane(singleRef)}
            />
          )}
        </div>
        {/* On the canvas, out of the flow (R18): the states sit over it. */}
        <CanvasModeLabel mode={mode} />
        <StageStates
          states={states}
          onRetry={onRetry}
          onRetryDiff={onRetryDiff}
          retryingDiff={retryingDiff}
          onFocusLost={focusPane(singleRef)}
        />
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
