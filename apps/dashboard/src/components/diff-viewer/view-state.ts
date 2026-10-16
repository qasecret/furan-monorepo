"use client";

import { create } from "zustand";

import type { Bbox } from "./region-resize";
import { clampZoom, zoomAbout, type Size, type View } from "./viewer-geometry";

/**
 * How the reviewer is looking at the step on screen (spec §6.2): zoom, pan,
 * the swipe position, the flicker frame, the selected region and whether
 * suppressed regions show. None of it
 * carries to another step: the viewer resets it on every step change and
 * every viewport switch (`resetView`). The store is a module singleton that
 * outlives the viewer's remounts, so the reset is explicit, never left to a
 * remount.
 */

export type FlickerFrame = "baseline" | "current";

/** The frame a swap shows next. */
export function otherFrame(frame: FlickerFrame): FlickerFrame {
  return frame === "baseline" ? "current" : "baseline";
}

/** Zoom, and the pan in world px (R12): see `View`. */
interface ViewState extends View {
  /** Set by the diff stepper to ask the canvas to frame a region; the canvas
   * applies it and clears it back to null. */
  focusBbox: Bbox | null;
  /** Swipe's divider, as a fraction of the canvas width (0..1). */
  swipe: number;
  flickerFrame: FlickerFrame;
  flickerPlaying: boolean;
  /**
   * The frame on screen was put there by hand (`f` while paused), so the
   * flicker's live region names it (spec §4.3). Every other change to the
   * flicker clears it (`setFlicker`, a reset): an animated swap is never
   * announced, and the next swap by hand always is.
   */
  flickerSwappedByHand: boolean;
  /** The selected diff region (the region list, the stepper, a canvas click). */
  selectedRegionId: string | null;
  /**
   * "Show suppressed": the audit rows the region list hides by default, shown
   * on every region surface (the list, the canvas) while it is on (R10).
   */
  showSuppressed: boolean;

  /** Multiplies the zoom (e.g. ZOOM_STEP for one step in), clamped. */
  zoomBy(f: number): void;
  /** Zooms by `f` about canvas point `p`: the world point under it stays put. */
  zoomAt(
    f: number,
    p: { x: number; y: number },
    world: Size,
    viewport: Size,
  ): void;
  setZoom(z: number): void;
  /** Back to fit: zoom 1 and no pan, in one change. */
  resetZoom(): void;
  /**
   * Pans by a drag of (dx, dy) canvas px, at `scale` canvas px per world px
   * (the world transform's scale): the pan is kept in world px.
   */
  panBy(dx: number, dy: number, scale: number): void;
  /** Zoom and pan at once (the stepper's focus), the zoom clamped. */
  setView(v: View): void;
  setSwipe(v: number): void;
  /** The frame and the play state together; forgets a swap by hand. */
  setFlicker(frame: FlickerFrame, playing: boolean): void;
  /** A swap by hand (`f` while paused): the other frame, paused, announced. */
  swapFlicker(): void;
  setSelected(id: string | null): void;
  setShowSuppressed(on: boolean): void;
  setFocusBbox(b: Bbox | null): void;
  /** Every field back to its default; the flicker plays unless motion is reduced. */
  resetView(opts: { reducedMotion: boolean }): void;
}

const fresh = (reducedMotion: boolean) => ({
  zoom: 1,
  panX: 0,
  panY: 0,
  focusBbox: null,
  swipe: 0.5,
  flickerFrame: "baseline" as const,
  flickerPlaying: !reducedMotion,
  flickerSwappedByHand: false,
  selectedRegionId: null,
  showSuppressed: false,
});

export const useViewState = create<ViewState>((set) => ({
  ...fresh(false),
  zoomBy: (f) => set((s) => ({ zoom: clampZoom(s.zoom * f) })),
  zoomAt: (f, p, world, viewport) =>
    set((s) => {
      const next = zoomAbout(s, f, p, world, viewport);
      // At a limit the zoom holds, and so does the pan: scrolling on past
      // it must not drift the view.
      return next.zoom === s.zoom ? {} : next;
    }),
  setZoom: (z) => set({ zoom: clampZoom(z) }),
  resetZoom: () => set({ zoom: 1, panX: 0, panY: 0 }),
  panBy: (dx, dy, scale) =>
    set((s) => {
      if (!(scale > 0) || !Number.isFinite(scale)) return {};
      return { panX: s.panX + dx / scale, panY: s.panY + dy / scale };
    }),
  setView: ({ zoom, panX, panY }) => set({ zoom: clampZoom(zoom), panX, panY }),
  setSwipe: (v) =>
    set(() =>
      Number.isFinite(v) ? { swipe: Math.min(1, Math.max(0, v)) } : {},
    ),
  setFlicker: (flickerFrame, flickerPlaying) =>
    set({ flickerFrame, flickerPlaying, flickerSwappedByHand: false }),
  swapFlicker: () =>
    set((s) => ({
      flickerFrame: otherFrame(s.flickerFrame),
      flickerPlaying: false,
      flickerSwappedByHand: true,
    })),
  setSelected: (selectedRegionId) => set({ selectedRegionId }),
  setShowSuppressed: (showSuppressed) => set({ showSuppressed }),
  setFocusBbox: (focusBbox) => set({ focusBbox }),
  resetView: ({ reducedMotion }) => set(fresh(reducedMotion)),
}));
