"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { create } from "zustand";

import { VIEWER_MODES, type ViewerMode } from "./comparison-modes";
import { modeAvailable, useViewerPrefs } from "./viewer-prefs";

export { parseViewParam } from "./comparison-modes";

/**
 * The diff viewer's effective comparison mode: the one place that decides
 * which mode is on screen (spec §6.3, R3). Every part of the viewer (the
 * stage, the toolbar, the keys) reads it from here.
 *
 * Precedence: the ignore-region editor's override (R3), then the URL's
 * `?view`, then the stored preference (§6.1). A mode the step can't show (no
 * baseline, R2) is side by side, and whatever chose it is kept: neither the
 * URL nor the preference changes, so the next step that can show it does.
 */

export interface ModeInputs {
  /** R3: the editor's mode while it is open, else null. */
  editorOverride: ViewerMode | null;
  /** The URL's `?view`; null when it names no mode. */
  urlView: ViewerMode | null;
  /** The stored preference. */
  preferred: ViewerMode;
  /** The step on screen has a baseline. */
  hasBaseline: boolean;
}

/** The mode on screen. Pure. */
export function effectiveMode({
  editorOverride,
  urlView,
  preferred,
  hasBaseline,
}: ModeInputs): ViewerMode {
  const chosen = editorOverride ?? urlView ?? preferred;
  return modeAvailable(chosen, hasBaseline) ? chosen : "side-by-side";
}

// ---------- the editor's override (R3) ----------

/**
 * R3: the mode the ignore-region editor puts on screen while it is open (from
 * Swipe or Flicker it shows side by side; Task 12 sets it). Session-only: it
 * outranks `?view` and the preference, and is never stored nor written to the
 * URL.
 */
const useEditorOverride = create<{ mode: ViewerMode | null }>(() => ({
  mode: null,
}));

/** Sets the editor's override, or clears it (null). */
export function setEditorOverride(mode: ViewerMode | null): void {
  useEditorOverride.setState({ mode });
}

/**
 * The mode on screen now, read outside React (a command, at its key press).
 * `urlView` is the viewer's view (`useViewerMode().view`).
 */
export function readEffectiveMode(
  urlView: ViewerMode | null,
  hasBaseline: boolean,
): ViewerMode {
  return effectiveMode({
    editorOverride: useEditorOverride.getState().mode,
    urlView,
    preferred: useViewerPrefs.getState().prefs.mode,
    hasBaseline,
  });
}

/** The same, kept current: re-renders on the override and the preference. */
function useModeFor(
  urlView: ViewerMode | null,
  hasBaseline: boolean,
): ViewerMode {
  const editorOverride = useEditorOverride((s) => s.mode);
  const preferred = useViewerPrefs((s) => s.prefs.mode);
  return effectiveMode({ editorOverride, urlView, preferred, hasBaseline });
}

// ---------- the viewer's parts ----------

export interface ViewerModeContextValue {
  /** The URL's `?view`, as last written (`useViewerMode().view`). */
  view: ViewerMode | null;
  /** `useViewerMode().setMode`. */
  setMode(mode: ViewerMode): void;
}

/**
 * What the viewer hands its parts, so each reads the one mode. Outside a
 * viewer there is no URL: the preference alone.
 */
const ViewerModeContext = createContext<ViewerModeContextValue>({
  view: null,
  setMode: (mode) => useViewerPrefs.getState().set("mode", mode),
});
export const ViewerModeProvider = ViewerModeContext.Provider;

/** The mode on screen, for a part of the viewer (the stage, the toolbar). */
export function useEffectiveMode(hasBaseline: boolean): ViewerMode {
  return useModeFor(useContext(ViewerModeContext).view, hasBaseline);
}

/** Chooses a mode, for a part of the viewer: `useViewerMode().setMode`. */
export function useSetViewerMode(): (mode: ViewerMode) => void {
  return useContext(ViewerModeContext).setMode;
}

// ---------- the viewer ----------

export interface ViewerModeInput {
  /** The URL's `?view`, as the page parsed it (`parseViewParam`). */
  urlView: ViewerMode | null;
  /** The step on screen has a baseline. */
  hasBaseline: boolean;
  /**
   * The path of the step on screen, when the viewer knows it. A step change
   * shows its step at once and replaces the URL; until the route commits,
   * `usePathname` still names the step left, and a mode change written there
   * would call the step change off. Defaults to the URL's path.
   */
  path?: string;
}

export interface ViewerModeState {
  mode: ViewerMode;
  available: Record<ViewerMode, boolean>;
  /**
   * Stores the preference and replaces the URL with `view=‹mode›`, every
   * other param as it is (no history entry, no scroll), and shows the mode at
   * once. A mode the step can't show is not chosen on it.
   */
  setMode(mode: ViewerMode): void;
  /**
   * The `?view` the viewer's own links carry (spec §6.3): the URL's, as last
   * written, whatever the step on screen can show. Null: the URL has none,
   * and the next step opens in the preference.
   */
  view: ViewerMode | null;
}

/**
 * The viewer's mode, its URL and its preference. Called once, by the viewer,
 * which hands `view` and `setMode` to its parts (`ViewerModeProvider`).
 */
export function useViewerMode({
  urlView,
  hasBaseline,
  path,
}: ViewerModeInput): ViewerModeState {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  // The view `setMode` last wrote, and the URL's view when it did. The router
  // re-renders the page with the new URL only after a round trip; until the
  // URL's view changes, what was written is the view. Then it is dropped for
  // good, and the URL's is (it caught up, or the page was opened on another
  // view).
  const [written, setWritten] = useState<{
    view: ViewerMode;
    over: ViewerMode | null;
  } | null>(null);
  if (written !== null && written.over !== urlView) setWritten(null);
  const view =
    written !== null && written.over === urlView ? written.view : urlView;
  const mode = useModeFor(view, hasBaseline);

  // The newest query string we know of: the URL's, or the one the last
  // change wrote before the router re-rendered us with it.
  const latest = useRef(search);
  useEffect(() => {
    latest.current = search;
  }, [search]);
  // What `setMode` acts on when it is called, not when it was made.
  const live = useRef({ urlView, view, hasBaseline, path: path ?? pathname });
  live.current = { urlView, view, hasBaseline, path: path ?? pathname };

  const setMode = useCallback(
    (next: ViewerMode) => {
      const now = live.current;
      if (!modeAvailable(next, now.hasBaseline)) return;
      const from = readEffectiveMode(now.view, now.hasBaseline);
      const prefs = useViewerPrefs.getState();
      const before = prefs.previousMode;
      prefs.set("mode", next);
      // `d`'s way back from Diff is the mode left on screen, which `?view`
      // may have chosen over the preference.
      useViewerPrefs.setState({
        previousMode: from !== next && from !== "diff" ? from : before,
      });
      if (now.view === next) return;
      setWritten({ view: next, over: now.urlView });
      const params = new URLSearchParams(latest.current);
      params.set("view", next);
      latest.current = params.toString();
      router.replace(`${now.path}?${latest.current}${window.location.hash}`, {
        scroll: false,
      });
    },
    [router],
  );

  const available = useMemo(
    () =>
      Object.fromEntries(
        VIEWER_MODES.map((m) => [m, modeAvailable(m, hasBaseline)]),
      ) as Record<ViewerMode, boolean>,
    [hasBaseline],
  );

  return { mode, available, setMode, view };
}
