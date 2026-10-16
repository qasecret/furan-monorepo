"use client";

import { ChevronsLeftRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";

/** ← / → move the divider this many percent of the stage (spec §4.2). */
export const SWIPE_KEY_STEP = 2;
/** Shift+← / → move it this many. */
export const SWIPE_SHIFT_STEP = 10;

/** The copy, verbatim from spec §8. */
const NAME = "Swipe position";
const valueText = (percent: number) => `${percent}% baseline`;

const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));

interface Props {
  /** The divider, as a fraction of the stage's width (0..1). */
  value: number;
  /** A new fraction, within 0..1. */
  onChange(value: number): void;
}

/**
 * Swipe's divider handle (spec §4.2), over the stage that holds it: a strip
 * the stage's height along the divider, with a 24 px handle on it that is
 * the slider. The canvas draws the divider itself; this is where it is held.
 *
 * - **Place.** In % of the stage, so a resize or a browser zoom keeps it at
 *   its fraction without waiting for a render (Review Focus 5), as the
 *   canvas's divider does.
 * - **Pointer.** A drag on the strip or the handle moves the divider by the
 *   pointer's travel, so a press alone moves nothing. The pointer is
 *   captured, so the drag holds when it leaves the strip. The listeners are
 *   native, and keep the press to themselves: the stage's pan listens
 *   natively on the stage, where React's handlers would only stop it after
 *   it had run. A click elsewhere on the canvas never moves the divider.
 * - **Keys** are the slider's own, not commands: ← / → 2%, Shift 10%, and
 *   Home / End to the ends, clamped. Each one is taken (`preventDefault`),
 *   so the viewer's ← / → step commands yield to it (the command guard's
 *   `defaultPrevented`), at the ends too. Chords are left alone: Alt+← is
 *   the browser's back.
 */
export function SwipeHandle({ value, onChange }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  // The pointer listeners are bound once and read the latest props.
  const latest = useRef({ value, onChange });
  useLayoutEffect(() => {
    latest.current = { value, onChange };
  });

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    // The pointer holding the divider, and how far right of it it took hold.
    let drag: { id: number; offset: number } | null = null;
    const stage = () => {
      const rect = strip.parentElement?.getBoundingClientRect();
      return rect && rect.width > 0 ? rect : null;
    };
    const onDown = (e: PointerEvent) => {
      // Middle-drag still pans the stage.
      if (e.button !== 0) return;
      e.stopPropagation();
      // No text selection; the handle takes the focus below.
      e.preventDefault();
      const rect = stage();
      if (!rect) return;
      const at = rect.left + latest.current.value * rect.width;
      drag = { id: e.pointerId, offset: e.clientX - at };
      strip.setPointerCapture(e.pointerId);
      handleRef.current?.focus({ preventScroll: true });
    };
    const onMove = (e: PointerEvent) => {
      if (drag === null || drag.id !== e.pointerId) return;
      e.stopPropagation();
      const rect = stage();
      if (!rect) return;
      const x = e.clientX - drag.offset - rect.left;
      latest.current.onChange(clamp(x / rect.width, 1));
    };
    const onEnd = (e: PointerEvent) => {
      if (drag === null || drag.id !== e.pointerId) return;
      e.stopPropagation();
      drag = null;
      if (strip.hasPointerCapture(e.pointerId)) {
        strip.releasePointerCapture(e.pointerId);
      }
    };
    const onLost = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) drag = null;
    };
    strip.addEventListener("pointerdown", onDown);
    strip.addEventListener("pointermove", onMove);
    strip.addEventListener("pointerup", onEnd);
    strip.addEventListener("pointercancel", onEnd);
    strip.addEventListener("lostpointercapture", onLost);
    return () => {
      strip.removeEventListener("pointerdown", onDown);
      strip.removeEventListener("pointermove", onMove);
      strip.removeEventListener("pointerup", onEnd);
      strip.removeEventListener("pointercancel", onEnd);
      strip.removeEventListener("lostpointercapture", onLost);
    };
  }, []);

  const percent = Math.round(value * 100);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? SWIPE_SHIFT_STEP : SWIPE_KEY_STEP;
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = percent - step;
        break;
      case "ArrowRight":
        next = percent + step;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 100;
        break;
      default:
        return;
    }
    e.preventDefault();
    onChange(clamp(next, 100) / 100);
  };

  return (
    <div
      ref={stripRef}
      data-testid="swipe-divider"
      className="absolute inset-y-0 z-10 w-6 -translate-x-1/2 cursor-ew-resize touch-none select-none"
      style={{ left: `${value * 100}%` }}
    >
      <div
        ref={handleRef}
        role="slider"
        tabIndex={0}
        aria-label={NAME}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText(percent)}
        onKeyDown={onKeyDown}
        className="absolute left-1/2 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-ring bg-raised text-fg-secondary shadow-raised focus-ring"
      >
        <ChevronsLeftRight className="h-3.5 w-3.5" aria-hidden />
      </div>
    </div>
  );
}
