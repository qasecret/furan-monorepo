import type { Container } from "pixi.js";

import type { ImageRole } from "../image-set";
import type { Rect, Size, Transform, World } from "../viewer-geometry";
import type { ViewerMode } from "../viewer-prefs";

import { diff } from "./diff";
import { overlay } from "./overlay";
import { sideBySide } from "./side-by-side";
import { swipe } from "./swipe";

/**
 * The comparison modes as renderers (spec §3.3). Each builds its own layers
 * in a declared order, bottom to top, and labels every display object it
 * adds, so the order is checkable. Above them the host (`ViewerStage`) stacks
 * the layers every mode shares: highlight shading, the severity rectangles
 * and the ignore-region editor.
 */

export interface RenderInput {
  world: World;
  images: { baseline?: ImageBitmap; current?: ImageBitmap; diff?: ImageBitmap };
  /** The current image's opacity over the baseline in Overlay, 0..1. */
  opacity: number;
  /** Swipe's divider, as a fraction of the canvas width (0..1). */
  swipe: number;
  flickerFrame: "baseline" | "current";
  /**
   * From the tokens, via `canvas-theme`: the hatching from `--fg-muted`,
   * Swipe's divider from `--ring`.
   */
  colors: { hatch: number; divider: number };
  /**
   * World to canvas px on the host's pane, the transform the host places the
   * world with. Its scale sizes the marks that keep a screen size (the
   * hatch's spacing, the divider's width).
   */
  transform: Transform;
  /** That pane's canvas, in canvas px: Swipe's divider is a fraction of it. */
  canvas: Size;
}

export interface ModeHandle {
  /**
   * Applies the inputs a mount can take in place: the world, the transform
   * and the canvas (the hatching and Swipe's divider follow them), the
   * opacity, the swipe, the flicker frame and the colours. The images are
   * fixed for a mount; the host mounts again for new ones.
   */
  update(input: RenderInput): void;
  /**
   * Destroys every display object the mount added, with its texture and the
   * texture's source. Never closes a bitmap: they are the image cache's.
   * Safe to call twice.
   */
  dispose(): void;
}

/** What says where Swipe's divider is: the world, placed on a canvas. */
export type SplitInput = Pick<
  RenderInput,
  "world" | "transform" | "canvas" | "swipe"
>;

/** A layer the host mounts above a renderer's own. */
export type HostLayer = "shading" | "regions" | "ignore";

/** An image whose missing area (`World.missing`) a renderer hatches. */
export type HatchedImage = keyof World["missing"];

export interface ModeRenderer {
  /** Side by side has 2; every other mode draws on one stage. */
  panes: 1 | 2;
  /** The images that must have loaded (or failed) before it mounts. */
  needs(input: { hasBaseline: boolean }): ImageRole[];
  /**
   * The images it puts on a texture (diff waits for the baseline but never
   * draws it). One the GPU can't hold is left out of its input.
   */
  draws: readonly ImageRole[];
  /** `worlds.length === panes`. Adds the mode's own layers to them. */
  mount(worlds: Container[], input: RenderInput): ModeHandle;
  /**
   * Where the host draws its layers: the pane (an index into `worlds`) and
   * which layers, bottom to top. They always sit above the mode's own.
   */
  host: { pane: number; layers: readonly HostLayer[] };
  /**
   * Per pane (an index into `worlds`), the images whose missing area it
   * hatches, when that image is drawn. The host puts the hatching's
   * tooltips over the same areas.
   */
  hatched: readonly (readonly HatchedImage[])[];
  /**
   * Where each image shows, in world px, for a mode that shows an image in
   * only part of the world (Swipe: the baseline left of the divider, the
   * current right of it, R15). It clips the image and its hatching there,
   * and the host clips the hatching's tooltips to the same area. Absent:
   * each image shows over the whole world.
   */
  shownIn?(input: SplitInput): Record<HatchedImage, Rect>;
}

/**
 * Flicker draws as side by side until its renderer lands (R1): the chosen
 * mode is kept, and drawn as `drawnMode` says.
 */
export const RENDERERS: Record<ViewerMode, ModeRenderer> = {
  "side-by-side": sideBySide,
  swipe,
  flicker: sideBySide,
  overlay,
  diff,
};
