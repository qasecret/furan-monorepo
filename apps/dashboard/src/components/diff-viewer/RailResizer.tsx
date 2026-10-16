"use client";

import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { railMaxWidth, useWindowWidth } from "./rail-state";
import {
  DEFAULT_VIEWER_PREFS,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
} from "./viewer-prefs";

/** ← / → change the rail's width by this many px (spec §5). */
export const RAIL_KEY_STEP = 16;
/** Shift+← / → change it by this many. */
export const RAIL_SHIFT_STEP = 64;

/** The copy, verbatim from spec §8. */
const NAME = "Resize details";

/** A width the rail may be asked for: 280–560 px, in whole px. */
const clamp = (w: number) =>
  Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(w)));

interface Props {
  /** The rail's width on screen, in px. */
  width: number;
  /**
   * A width asked for, within 280–560: `commit` false while a drag moves
   * (show it, don't store it), true at its end and on each key (store it).
   * The window's own cap is the rail's to apply: a key or a drag past it
   * asks for more than the window shows, and the rail keeps the stored width.
   */
  onResize(width: number, commit: boolean): void;
}

/** The pointer holding the separator: where it took hold, and the width then. */
interface Drag {
  id: number;
  x: number;
  from: number;
  /** The last width asked for; null until the pointer has moved it. */
  last: number | null;
}

/**
 * The info rail's resize handle (spec §5), along the rail's left edge: a
 * focusable window splitter (`role="separator"`) whose value is the rail's
 * width in px, from 280 up to the window's cap (560, and never over 45% of
 * the window).
 *
 * - **Keys** are its own, not commands: → / ← widen and narrow by 16 px,
 *   Shift by 64, and Home / End go to the minimum and the maximum. Each is
 *   taken (`preventDefault`), so the viewer's ← / → step commands yield to
 *   it (the command guard's `defaultPrevented`), and each is stored. Chords
 *   are left alone: Alt+← is the browser's back.
 * - **Pointer.** Dragging the edge left widens the rail by the pointer's
 *   travel. The pointer is captured, so the drag holds off the handle. Each
 *   move is shown and only the last is stored, at pointerup; a press that
 *   moves nothing stores nothing.
 * - **A double click** puts the default 320 px back, stored.
 */
export function RailResizer({ width, onResize }: Props) {
  const max = railMaxWidth(useWindowWidth());
  const drag = useRef<Drag | null>(null);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = e.shiftKey ? RAIL_SHIFT_STEP : RAIL_KEY_STEP;
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = width - step;
        break;
      case "ArrowRight":
        next = width + step;
        break;
      case "Home":
        next = RAIL_MIN_WIDTH;
        break;
      case "End":
        // The maximum: the window shows its own cap of it.
        next = RAIL_MAX_WIDTH;
        break;
      default:
        return;
    }
    e.preventDefault();
    onResize(clamp(next), true);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // No text selection; the separator takes the focus instead.
    e.preventDefault();
    drag.current = { id: e.pointerId, x: e.clientX, from: width, last: null };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (held === null || held.id !== e.pointerId) return;
    const next = clamp(held.from + (held.x - e.clientX));
    if (next === (held.last ?? held.from)) return;
    held.last = next;
    onResize(next, false);
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (held === null || held.id !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (held.last !== null) onResize(held.last, true);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={NAME}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={RAIL_MIN_WIDTH}
      aria-valuemax={max}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={() => onResize(DEFAULT_VIEWER_PREFS.railWidth, true)}
      data-testid="rail-resizer"
      // An 8 px grip over the rail's left border, half on the canvas side.
      // The ring is inset: the viewer body is overflow-hidden and would clip
      // an outset one at the top and bottom.
      className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none select-none focus-ring focus-visible:-outline-offset-2"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-edge-strong"
      />
    </div>
  );
}
