"use client";

import type { ReactNode } from "react";

import type { ViewerMode } from "./comparison-modes";
import { useViewState, type FlickerFrame } from "./view-state";

/** Which of side by side's two panes a label names. */
export type CanvasPane = "baseline" | "current";

/** Flicker's frames, named (spec §8). */
const FRAME_LABEL: Record<FlickerFrame, string> = {
  baseline: "Baseline",
  current: "Current",
};

/**
 * What the canvas shows, in words (spec §4.1, §8): side by side's panes
 * "Baseline" (or "No baseline", on a new test) and "Current"; Swipe
 * "Baseline | Current", the baseline left of the divider; Flicker the frame
 * on screen; Overlay "Current over baseline"; Diff "Current", the image its
 * changes are drawn over.
 */
export function canvasModeLabel(
  mode: ViewerMode,
  {
    pane = "current",
    frame = "baseline",
    hasBaseline = true,
  }: { pane?: CanvasPane; frame?: FlickerFrame; hasBaseline?: boolean } = {},
): string {
  switch (mode) {
    case "side-by-side":
      if (pane === "current") return "Current";
      return hasBaseline ? "Baseline" : "No baseline";
    case "swipe":
      return "Baseline | Current";
    case "flicker":
      return FRAME_LABEL[frame];
    case "overlay":
      return "Current over baseline";
    case "diff":
      return "Current";
  }
}

interface Props {
  /** The mode on screen (`useEffectiveMode`). */
  mode: ViewerMode;
  /** Side by side: the pane this label is on. */
  pane?: CanvasPane;
  /** The step has a baseline: side by side's pane A says so when it hasn't. */
  hasBaseline?: boolean;
  /** Shown after the words: side by side's has-differences badge. */
  children?: ReactNode;
}

/**
 * Names what a card of the canvas shows (spec §4.1), on the canvas (R18):
 * overlaid on the card's top-left, out of the layout, so no mode moves the
 * card for it, and it lets the pointer through to the canvas. Placed in the
 * card's wrapper, beside the stage's states, which sit over it. In Flicker it
 * follows every swap; it is not a live region, as it would then speak twice a
 * second (the flicker's own region says a swap by hand).
 */
export function CanvasModeLabel({
  mode,
  pane,
  hasBaseline = true,
  children,
}: Props) {
  // Only Flicker's label follows the frame: the other modes never re-render
  // for a swap.
  const frame = useViewState((s) =>
    mode === "flicker" ? s.flickerFrame : "baseline",
  );
  return (
    <div
      className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-edge bg-overlay px-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-fg-secondary shadow-overlay"
      data-testid="canvas-mode-label"
      data-pane={pane}
    >
      {canvasModeLabel(mode, {
        ...(pane ? { pane } : {}),
        frame,
        hasBaseline,
      })}
      {children}
    </div>
  );
}
