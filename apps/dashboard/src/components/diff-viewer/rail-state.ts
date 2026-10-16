"use client";

import { useSyncExternalStore } from "react";
import { create } from "zustand";

import {
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  useViewerPrefs,
  type RailTab,
} from "./viewer-prefs";

/**
 * The info rail's state beyond the stored preferences (spec §5): what this
 * visit decided about it below 1024 px, which is never stored, and whether a
 * rail is on screen for its keys to act on. The width, the collapsed state
 * and the tab themselves are preferences (`viewer-prefs`).
 */

/** Below this window width the rail starts collapsed and, opened, overlays the canvas. */
export const RAIL_NARROW_BELOW = 1024;
/** The collapsed strip's width, in px. */
export const RAIL_STRIP_WIDTH = 40;
/** The rail is never wider than this share of the window. */
export const RAIL_MAX_SHARE = 0.45;

/** The rail's element, open or collapsed (`focusInRail`). */
const RAIL_SELECTOR = "[data-info-rail]";

/**
 * The widest the rail may be in a window `windowWidth` px wide: 560, and
 * never over 45% of the window. Never under the 280 minimum, which a window
 * under 623 px would ask for (the viewer itself needs 768: its mobile gate).
 */
export function railMaxWidth(windowWidth: number): number {
  return Math.max(
    RAIL_MIN_WIDTH,
    Math.min(RAIL_MAX_WIDTH, Math.floor(windowWidth * RAIL_MAX_SHARE)),
  );
}

function windowWidthNow(): number {
  return typeof window === "undefined" ? RAIL_NARROW_BELOW : window.innerWidth;
}

/** True when the window is under 1024 px (`RAIL_NARROW_BELOW`). */
export function isNarrowWindow(width: number = windowWidthNow()): boolean {
  return width < RAIL_NARROW_BELOW;
}

function onResize(changed: () => void): () => void {
  window.addEventListener("resize", changed);
  return () => window.removeEventListener("resize", changed);
}

/**
 * The window's width in CSS px, live: a resize or a browser zoom (which
 * changes it too) renders again. Client only: the viewer is never rendered
 * on the server.
 */
export function useWindowWidth(): number {
  return useSyncExternalStore(
    onResize,
    windowWidthNow,
    () => RAIL_NARROW_BELOW,
  );
}

/** The button a collapse or an expansion gives focus to: the counterpart. */
type FocusMove = "show" | "hide";

interface RailState {
  /**
   * This visit's own collapsed state, never stored: true when the visit
   * starts below 1024 px, and whatever a toggle in a narrow window last set.
   * Null: the stored preference applies.
   */
  visit: boolean | null;
  /** The visit's start has been looked at (`startRailVisit`). */
  started: boolean;
  /** How many rails are mounted: its keys act only while one is on screen. */
  mounted: number;
  /**
   * A focus move the rail owes once it renders its new state: to "Show
   * details" after a collapse, to "Hide details" after an expansion.
   */
  focus: FocusMove | null;
}

export const useRailState = create<RailState>(() => ({
  visit: null,
  started: false,
  mounted: 0,
  focus: null,
}));

/**
 * Starts the visit, once per page load (the rail's first mount; the viewer
 * remounts on every step and the store outlives it): below 1024 px the rail
 * starts collapsed, without storing it. Idempotent.
 */
export function startRailVisit(windowWidth: number = windowWidthNow()): void {
  if (useRailState.getState().started) return;
  useRailState.setState({
    started: true,
    visit: isNarrowWindow(windowWidth) ? true : null,
  });
}

/** Whether the rail is collapsed now: the visit's state, else the preference. */
export function railCollapsed(): boolean {
  return (
    useRailState.getState().visit ??
    useViewerPrefs.getState().prefs.railCollapsed
  );
}

/** `railCollapsed`, for rendering. */
export function useRailCollapsed(): boolean {
  const visit = useRailState((s) => s.visit);
  const stored = useViewerPrefs((s) => s.prefs.railCollapsed);
  return visit ?? stored;
}

/** A rail is on screen. */
export function railPresent(): boolean {
  return useRailState.getState().mounted > 0;
}

/** The rail is open over the canvas: on screen, open, in a narrow window. */
export function railOverlaid(): boolean {
  return railPresent() && !railCollapsed() && isNarrowWindow();
}

/** Focus is in the rail, open or collapsed. */
export function focusInRail(): boolean {
  if (typeof document === "undefined") return false;
  const focused = document.activeElement;
  return focused instanceof Element && focused.closest(RAIL_SELECTOR) !== null;
}

export interface RailMoveOptions {
  /**
   * Give focus to the counterpart button once the rail has its new state.
   * By default only when focus is in the rail now, as what holds it is about
   * to go; a button of the rail says so itself, as a click need not focus
   * it (Safari).
   */
  moveFocus?: boolean;
}

/**
 * Collapses or opens the rail (spec §5). In a narrow window only for this
 * visit, never stored; in a wide one it is stored, and the visit's own
 * state goes. Nothing happens when it is already so.
 */
export function setRailCollapsed(
  collapsed: boolean,
  { moveFocus = focusInRail() }: RailMoveOptions = {},
): void {
  if (railCollapsed() === collapsed) return;
  const focus: FocusMove | null = moveFocus
    ? collapsed
      ? "show"
      : "hide"
    : null;
  if (isNarrowWindow()) {
    useRailState.setState({ visit: collapsed, focus });
    return;
  }
  // The preference first: the rail renders its new state with the focus
  // move it owes, never the move ahead of the state.
  useViewerPrefs.getState().set("railCollapsed", collapsed);
  useRailState.setState({ visit: null, focus });
}

/** Opens the rail on `tab`, which is stored wherever the window is. */
export function openRailOn(tab: RailTab, opts: RailMoveOptions = {}): void {
  const { prefs, set } = useViewerPrefs.getState();
  if (prefs.railTab !== tab) set("railTab", tab);
  setRailCollapsed(false, opts);
}
