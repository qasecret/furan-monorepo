"use client";

import { useEffect, useLayoutEffect, useState } from "react";

import { useTour, type TourStep } from "./tour-context";

import { Button } from "@/components/ui/button";

interface Position {
  top: number;
  left: number;
  /** Effective placement after viewport-clip flip. */
  placement: NonNullable<TourStep["placement"]>;
}

const POPOVER_OFFSET = 12;
const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT_ESTIMATE = 160;

/**
 * Resolves a target selector to its bounding rect + chooses a placement
 * that keeps the popover inside the viewport. Returns null when the
 * selector matches no element (the page's DOM has not rendered the
 * anchor yet — overlay renders nothing and the page step is silently
 * skipped on the next `next()`).
 */
function computePosition(step: TourStep): Position | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(step.target);
  if (!el || !(el instanceof HTMLElement)) return null;

  // Scroll the target into the visible area so the popover anchor is
  // on-screen. `block: 'center'` keeps it away from sticky headers.
  el.scrollIntoView({ behavior: "smooth", block: "center" });

  const rect = el.getBoundingClientRect();
  const requested = step.placement ?? "bottom";
  const viewportH = typeof window === "undefined" ? 0 : window.innerHeight;
  const viewportW = typeof window === "undefined" ? 0 : window.innerWidth;

  let placement = requested;
  // Flip vertically if the requested side would clip the viewport.
  if (
    placement === "bottom" &&
    rect.bottom + POPOVER_HEIGHT_ESTIMATE > viewportH
  ) {
    placement = "top";
  } else if (placement === "top" && rect.top - POPOVER_HEIGHT_ESTIMATE < 0) {
    placement = "bottom";
  }
  // Horizontal flip (cheaper to reason about with a wider popover).
  if (placement === "right" && rect.right + POPOVER_WIDTH > viewportW) {
    placement = "left";
  } else if (placement === "left" && rect.left - POPOVER_WIDTH < 0) {
    placement = "right";
  }

  let top = 0;
  let left = 0;
  switch (placement) {
    case "bottom":
      top = rect.bottom + POPOVER_OFFSET;
      left = Math.max(
        8,
        Math.min(
          viewportW - POPOVER_WIDTH - 8,
          rect.left + rect.width / 2 - POPOVER_WIDTH / 2,
        ),
      );
      break;
    case "top":
      top = rect.top - POPOVER_OFFSET - POPOVER_HEIGHT_ESTIMATE;
      left = Math.max(
        8,
        Math.min(
          viewportW - POPOVER_WIDTH - 8,
          rect.left + rect.width / 2 - POPOVER_WIDTH / 2,
        ),
      );
      break;
    case "right":
      top = rect.top + rect.height / 2 - POPOVER_HEIGHT_ESTIMATE / 2;
      left = rect.right + POPOVER_OFFSET;
      break;
    case "left":
      top = rect.top + rect.height / 2 - POPOVER_HEIGHT_ESTIMATE / 2;
      left = rect.left - POPOVER_OFFSET - POPOVER_WIDTH;
      break;
  }
  return { top, left, placement };
}

/**
 * Mounted at the app root inside `TourProvider`. Renders a backdrop +
 * popover anchored to the current step's target element. Listens for
 * ESC to dismiss + window resize/scroll to reposition.
 *
 * Renders nothing when the tour is inactive or the target selector is
 * not yet in the DOM — both are safe-no-op cases for SSR + hydration.
 */
export function TourOverlay() {
  const { state, next, prev, dismiss } = useTour();
  const [pos, setPos] = useState<Position | null>(null);

  const step = state.active ? state.steps[state.index] : null;

  // Recompute on step change + on viewport movement. `useLayoutEffect`
  // so the popover is positioned before paint and we never flash a
  // (0,0) popover for one frame.
  useLayoutEffect(() => {
    if (!step) {
      setPos(null);
      return;
    }
    const update = () => setPos(computePosition(step));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  // ESC to skip. Captures all key types in the document so popover-
  // mounted buttons do not need to forward.
  useEffect(() => {
    if (!state.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.active, dismiss]);

  if (!step || !pos) return null;

  const isFirst = state.index === 0;
  const isLast = state.index === state.steps.length - 1;

  return (
    <>
      {/* Backdrop dims the page so the active anchor stands out. Clicking
          the backdrop dismisses — same UX as legacy joyride's overlay. */}
      <div
        aria-hidden="true"
        onClick={dismiss}
        className="fixed inset-0 z-[1000] bg-black/40"
        data-testid="tour-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-step-title"
        data-testid="tour-popover"
        data-placement={pos.placement}
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: POPOVER_WIDTH,
          zIndex: 1001,
        }}
        className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
      >
        {step.title && (
          <h3
            id="tour-step-title"
            className="mb-2 text-sm font-semibold text-white"
          >
            {step.title}
          </h3>
        )}
        <p className="text-sm text-zinc-300">{step.content}</p>
        <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
          <span data-testid="tour-progress">
            {state.index + 1} / {state.steps.length}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={dismiss}
              className="px-2 py-1 text-xs"
              data-testid="tour-skip-button"
            >
              Skip
            </Button>
            {!isFirst && (
              <Button
                type="button"
                variant="secondary"
                onClick={prev}
                className="px-2 py-1 text-xs"
                data-testid="tour-prev-button"
              >
                Back
              </Button>
            )}
            <Button
              type="button"
              onClick={next}
              className="px-2 py-1 text-xs"
              data-testid="tour-next-button"
            >
              {isLast ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
