"use client";

import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { useReducedMotion } from "./useReducedMotion";
import { useViewerStore } from "./useViewerStore";
import { otherFrame, useViewState, type FlickerFrame } from "./view-state";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useCommandKeys } from "@/lib/commands/registry";

/**
 * Flicker's clock and its DOM (spec §4.3): the timer that swaps the frames,
 * the toolbar's Play / Pause, the label naming the frame on screen, and the
 * live region that says a swap by hand. The frames themselves are the
 * renderer's (`modes/flicker.ts`).
 */

/** One swap every 500 ms: 2 a second, under WCAG 2.3.1's 3 flashes. */
export const FLICKER_INTERVAL_MS = 500;

/**
 * A dialog over the viewer: one marked modal (`aria-modal`, as the tour is),
 * or an open Radix dialog (the palette, the shortcuts sheet, every
 * confirmation), which says `data-state="open"` and leaves `aria-modal` off.
 * The review loop's done card is a dialog too, but inline and unmarked: it
 * stands in place of the viewer, not over it.
 */
export const OPEN_MODAL_DIALOG = [
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"][aria-modal="true"]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
].join(",");

/** The page can't be seen, or a dialog is over the viewer. */
function covered(): boolean {
  return (
    document.visibilityState !== "visible" ||
    document.querySelector(OPEN_MODAL_DIALOG) !== null
  );
}

/**
 * Whether the page is hidden or a dialog is over it, watched only while
 * `watch` holds (the flicker would otherwise run): the page's visibility by
 * its event, the dialogs by the DOM, which a dialog enters as a node (a
 * portal) and leaves as a node or as a Radix `data-state` flip.
 */
function useCovered(watch: boolean): boolean {
  const [isCovered, setCovered] = useState(false);
  useEffect(() => {
    if (!watch) return;
    const check = () => setCovered(covered());
    check();
    document.addEventListener("visibilitychange", check);
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "aria-modal", "data-state"],
    });
    return () => {
      document.removeEventListener("visibilitychange", check);
      observer.disconnect();
    };
  }, [watch]);
  return watch && isCovered;
}

/**
 * Flicker's clock. It swaps the frame every 500 ms while all of these hold,
 * and otherwise has no timer at all, so the frame on screen stays:
 * - `active`: Flicker is on screen with both its frames drawn;
 * - the flicker is playing;
 * - reduced motion is off;
 * - the page is visible;
 * - the ignore-region editor is off;
 * - no dialog is over the viewer.
 *
 * When they hold again, the next swap is a whole interval away, so no two
 * swaps are ever closer than 500 ms.
 *
 * Under reduced motion it never plays: a live change to reduced motion
 * pauses it on the frame on screen, so `f` swaps from there.
 */
export function useFlickerTimer({
  active,
  reducedMotion,
}: {
  active: boolean;
  reducedMotion: boolean;
}): void {
  const playing = useViewState((s) => s.flickerPlaying);
  const editing = useViewerStore((s) => s.ignoreEditMode !== "off");

  useEffect(() => {
    if (!reducedMotion || !playing) return;
    const { flickerFrame, setFlicker } = useViewState.getState();
    setFlicker(flickerFrame, false);
  }, [reducedMotion, playing]);

  const wanted = active && playing && !reducedMotion && !editing;
  const isCovered = useCovered(wanted);
  const running = wanted && !isCovered;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const s = useViewState.getState();
      // A change that stops the timer may not have rendered yet: hold.
      if (
        !s.flickerPlaying ||
        useViewerStore.getState().ignoreEditMode !== "off" ||
        covered()
      ) {
        return;
      }
      s.setFlicker(otherFrame(s.flickerFrame), true);
    }, FLICKER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running]);
}

/**
 * The toolbar's Play / Pause while Flicker is on (spec §4.3), hidden under
 * reduced motion, where the flicker never plays and `f` swaps. Pause names
 * `f`'s keys, as `f` pauses a playing flicker; Play names none, as `f` swaps
 * a paused one instead of playing it.
 */
export function FlickerControls() {
  const playing = useViewState((s) => s.flickerPlaying);
  const reducedMotion = useReducedMotion();
  const keys = useCommandKeys("viewer.flicker.toggle");
  if (reducedMotion) return null;
  const label = playing ? "Pause" : "Play";
  const Icon = playing ? Pause : Play;
  return (
    <Button
      type="button"
      variant="secondary"
      className="gap-1.5 px-2 py-1 text-xs"
      data-testid="flicker-play-toggle"
      aria-keyshortcuts={playing ? keys.ariaKeyShortcuts : undefined}
      title={
        playing && keys.titleSuffix ? `${label}${keys.titleSuffix}` : undefined
      }
      onClick={() => {
        const { flickerFrame, setFlicker } = useViewState.getState();
        setFlicker(flickerFrame, !playing);
      }}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </Button>
  );
}

/** The label's copy (spec §8). */
const FRAME_LABEL: Record<FlickerFrame, string> = {
  baseline: "Baseline",
  current: "Current",
};

/**
 * Names the frame on screen, above the stage, and follows every swap (spec
 * §4.1). In the side-by-side panes' label style. Not a live region: while
 * the flicker plays it changes twice a second.
 */
export function FlickerFrameLabel() {
  const frame = useViewState((s) => s.flickerFrame);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-fg-muted"
      data-testid="canvas-mode-label"
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
          frame === "baseline" ? "bg-blue-500" : "bg-amber-500",
        )}
        aria-hidden
      />
      {FRAME_LABEL[frame]}
    </div>
  );
}

/** The live region's copy (spec §8). */
const SHOWING: Record<FlickerFrame, string> = {
  baseline: "Showing baseline",
  current: "Showing current",
};

/**
 * Flicker's polite live region (spec §4.3). It says the frame a swap by hand
 * put on screen, and nothing else: an animated swap never touches it, and
 * pausing, playing or leaving Flicker empties it, so the next swap by hand
 * is always news, even of the same frame.
 *
 * Always mounted, so what appears in it is announced. It is apart from the
 * stage's states, whose region is a status too: a status is read whole, so
 * sharing it would read those states again on every swap.
 */
export function FlickerAnnouncer({ on }: { on: boolean }) {
  const said = useViewState((s) =>
    on && s.flickerSwappedByHand ? SHOWING[s.flickerFrame] : "",
  );
  // Leaving Flicker forgets a swap by hand: coming back says nothing until
  // the next one.
  useEffect(() => {
    if (!on) useViewState.setState({ flickerSwappedByHand: false });
  }, [on]);
  return (
    <div role="status" className="sr-only" data-testid="flicker-status">
      {said}
    </div>
  );
}
