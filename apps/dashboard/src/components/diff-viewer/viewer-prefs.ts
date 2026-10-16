"use client";

import { z } from "zod";
import { create } from "zustand";

import { VIEWER_MODES, type ViewerMode } from "./comparison-modes";

/**
 * What the diff viewer remembers per user across reloads (spec §6.1): the
 * comparison mode, the overlay opacity, the toggles and the info rail. Kept
 * in localStorage under a versioned per-user key; a bad stored field falls
 * back to its default, and with no storage the viewer works on in-memory
 * defaults for the visit.
 */

export type RailTab = "info" | "history" | "comments";

/** The info rail's width range, in px. */
export const RAIL_MIN_WIDTH = 280;
export const RAIL_MAX_WIDTH = 560;

export interface ViewerPrefs {
  mode: ViewerMode;
  /** The current image's opacity over the baseline in Overlay, 0..1. */
  opacity: number;
  /** H: the pulsing highlight over the changed regions. */
  highlight: boolean;
  hideDisplacement: boolean;
  railWidth: number;
  railCollapsed: boolean;
  railTab: RailTab;
}

export const DEFAULT_VIEWER_PREFS: ViewerPrefs = Object.freeze({
  mode: "side-by-side",
  opacity: 0.5,
  highlight: true,
  hideDisplacement: false,
  railWidth: 320,
  railCollapsed: false,
  railTab: "info",
});

/** One schema per field, so each falls back on its own. */
const FIELDS: { [K in keyof ViewerPrefs]: z.ZodType<ViewerPrefs[K]> } = {
  mode: z.enum(VIEWER_MODES),
  opacity: z.number().min(0).max(1),
  highlight: z.boolean(),
  hideDisplacement: z.boolean(),
  railWidth: z.number().min(RAIL_MIN_WIDTH).max(RAIL_MAX_WIDTH),
  railCollapsed: z.boolean(),
  railTab: z.enum(["info", "history", "comments"]),
};

export function prefsKey(userId: string): string {
  return `furan:viewer:prefs:v1:${userId}`;
}

/** The page's localStorage, or null where it is blocked (the accessor throws). */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The user's stored preferences, field by field: a missing or invalid field
 * is its default and the rest are kept. Never throws: unreadable storage or
 * a value that is not a JSON object gives the defaults.
 */
export function readViewerPrefs(
  userId: string,
  storage: Storage | null = browserStorage(),
): ViewerPrefs {
  let stored: unknown;
  try {
    const raw = storage?.getItem(prefsKey(userId));
    stored = raw == null ? null : JSON.parse(raw);
  } catch {
    return { ...DEFAULT_VIEWER_PREFS };
  }
  const record: Record<string, unknown> =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const field = <K extends keyof ViewerPrefs>(k: K): ViewerPrefs[K] => {
    const parsed = FIELDS[k].safeParse(record[k]);
    return parsed.success ? parsed.data : DEFAULT_VIEWER_PREFS[k];
  };
  return {
    mode: field("mode"),
    opacity: field("opacity"),
    highlight: field("highlight"),
    hideDisplacement: field("hideDisplacement"),
    railWidth: field("railWidth"),
    railCollapsed: field("railCollapsed"),
    railTab: field("railTab"),
  };
}

/** Stores the user's preferences; a full or blocked storage is not an error. */
export function writeViewerPrefs(
  userId: string,
  prefs: ViewerPrefs,
  storage: Storage | null = browserStorage(),
): void {
  try {
    storage?.setItem(prefsKey(userId), JSON.stringify(prefs));
  } catch {
    // Not persisted (QuotaExceededError, privacy modes); the value still
    // holds in memory for this visit.
  }
}

interface ViewerPrefsState {
  /** Whose preferences these are; null until read, and with no user. */
  userId: string | null;
  prefs: ViewerPrefs;
  /** The mode `d` returns to from Diff. Session-only, never stored. */
  previousMode: Exclude<ViewerMode, "diff">;
  /**
   * Reads the user's stored preferences, once per user. With no user the
   * preferences are in memory only: the defaults, unless this visit has
   * already changed them (a null after a user drops that user's).
   */
  hydrate(userId: string | null): void;
  /**
   * Sets one preference, and stores it unless `persist` is false (a slider
   * mid-drag shows each value live and stores only its last).
   */
  set<K extends keyof ViewerPrefs>(
    k: K,
    v: ViewerPrefs[K],
    opts?: { persist?: boolean },
  ): void;
}

export const useViewerPrefs = create<ViewerPrefsState>((set, get) => ({
  userId: null,
  prefs: DEFAULT_VIEWER_PREFS,
  previousMode: "side-by-side",
  hydrate: (userId) => {
    // The viewer remounts on every step and the store outlives it: read the
    // user's preferences once, so a remount never undoes a change.
    if (get().userId === userId) return;
    set({
      userId,
      // No user: never another user's preferences, and no storage read.
      prefs: userId === null ? DEFAULT_VIEWER_PREFS : readViewerPrefs(userId),
      previousMode: "side-by-side",
    });
  },
  set: (k, v, opts) => {
    const { userId, prefs: old, previousMode } = get();
    const prefs = { ...old, [k]: v };
    set({
      prefs,
      // A mode left for another is `d`'s way back from Diff.
      previousMode:
        k === "mode" && old.mode !== "diff" ? old.mode : previousMode,
    });
    if (opts?.persist !== false && userId !== null) {
      writeViewerPrefs(userId, prefs);
    }
  },
}));

/**
 * Whether a mode can show a step (R2): every mode compares the current
 * screenshot with the baseline but side by side, which shows the current
 * screenshot alone when the step has no baseline (a new test).
 */
export function modeAvailable(mode: ViewerMode, hasBaseline: boolean): boolean {
  return hasBaseline || mode === "side-by-side";
}

/**
 * The mode a step shows for a chosen one (R2): that mode where the step can
 * show it, else side by side. Idempotent.
 */
export function modeOnStep(mode: ViewerMode, hasBaseline: boolean): ViewerMode {
  return modeAvailable(mode, hasBaseline) ? mode : "side-by-side";
}
