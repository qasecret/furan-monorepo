"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { create } from "zustand";

import {
  parseViewParam,
  VIEWER_MODES,
  type ViewerMode,
} from "./comparison-modes";
import { useViewerStore } from "./useViewerStore";
import { modeAvailable, modeOnStep, useViewerPrefs } from "./viewer-prefs";

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
  return modeOnStep(editorOverride ?? urlView ?? preferred, hasBaseline);
}

/**
 * Which modes a step can show (R2): every mode but side by side needs a
 * baseline.
 */
export function availableModes(
  hasBaseline: boolean,
): Record<ViewerMode, boolean> {
  return Object.fromEntries(
    VIEWER_MODES.map((m) => [m, modeAvailable(m, hasBaseline)]),
  ) as Record<ViewerMode, boolean>;
}

// ---------- the editor's override (R3) ----------

/**
 * R3: the mode the ignore-region editor puts on screen while it is open (from
 * Swipe or Flicker it shows side by side). Session-only: it outranks `?view`
 * and the preference, and is never stored nor written to the URL. The viewer
 * keeps it (`useViewerMode`).
 */
const useEditorOverride = create<{ mode: ViewerMode | null }>(() => ({
  mode: null,
}));

/** Sets the editor's override, or clears it (null). */
export function setEditorOverride(mode: ViewerMode | null): void {
  if (useEditorOverride.getState().mode !== mode) {
    useEditorOverride.setState({ mode });
  }
}

/**
 * The mode the ignore-region editor shows for the mode on screen (spec
 * §4.4). It always draws on the current image, which Swipe shows only on one
 * side of the divider and Flicker only every other frame: there it shows side
 * by side, and draws on pane B. Every other mode it draws on as it is.
 */
export function modeInEditor(mode: ViewerMode): ViewerMode {
  return mode === "swipe" || mode === "flicker" ? "side-by-side" : mode;
}

/** The editor's override for the mode on screen: none where it draws on it. */
function editorOverrideFor(mode: ViewerMode): ViewerMode | null {
  const shown = modeInEditor(mode);
  return shown === mode ? null : shown;
}

/** The ignore-region editor is open. */
export function editorOpen(): boolean {
  return useViewerStore.getState().ignoreEditMode !== "off";
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
  /** `useViewerMode().available`; absent, read from the step's baseline. */
  available?: Record<ViewerMode, boolean>;
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

/**
 * Which modes the step on screen can show, for a part of the viewer: the
 * viewer's `available` (N3: one place), or, outside one, the step's own.
 */
export function useAvailableModes(
  hasBaseline: boolean,
): Record<ViewerMode, boolean> {
  const { available } = useContext(ViewerModeContext);
  const own = useMemo(() => availableModes(hasBaseline), [hasBaseline]);
  return available ?? own;
}

// ---------- the viewer ----------

/**
 * The URL's `?view` (spec §6.3), as the viewer reads it (R31): from
 * `useSearchParams`, which Next keeps in step with `history.replaceState`.
 * So a mode change, a history write, re-renders no server page: the page's
 * props (`canReview`, `userId`) stay what they were.
 *
 * `pageView` is the page's own parse of the URL it was rendered for, kept for
 * the first render: it holds while the URL names no view and is still the one
 * the viewer opened on. Once the URL names a view, that view is the one. On
 * Back or Forward to an entry a mode change rewrote, Next restores the page as
 * it was rendered, so its parse can predate the rewrite; the URL can't.
 */
export function useUrlView(pageView: ViewerMode | null): ViewerMode | null {
  const params = useSearchParams();
  const search = params.toString();
  const [opened] = useState(search);
  const named = params.getAll("view");
  if (named.length > 0) {
    return parseViewParam(named.length === 1 ? named[0] : named);
  }
  return search === opened ? pageView : null;
}

export interface ViewerModeInput {
  /** The URL's `?view` (`useUrlView`). */
  urlView: ViewerMode | null;
  /** The step on screen has a baseline. */
  hasBaseline: boolean;
  /**
   * The step on screen (its checkpoint id). The editor's override (R3) is
   * the step's: a new step clears it, and sets it again only if the editor
   * is still open on Swipe or Flicker there.
   */
  step?: string;
  /**
   * The path of the step on screen, when the viewer knows it. A step change
   * shows its step at once and replaces the URL; until the route commits,
   * `usePathname` still names the step left. A mode change then goes with
   * the step change, as a replace to that step: written to the history, it
   * would call the step change off. Defaults to the URL's path.
   */
  path?: string;
  /**
   * R20: a navigation to another step on its way (the review loop's move, or
   * its `leave`), which a mode change would call off by writing the URL of
   * the step on screen: it is made again in the new mode instead
   * (`useReviewLoop().retarget`). True when there was one; then the step on
   * screen's URL is left alone.
   */
  retarget?: (view: ViewerMode) => boolean;
}

export interface ViewerModeState {
  mode: ViewerMode;
  available: Record<ViewerMode, boolean>;
  /**
   * Stores the preference and replaces the URL with `view=‹mode›`, every
   * other param and the fragment as they are, and shows the mode at once.
   * The URL is written with `history.replaceState` (R31): no navigation, so
   * no history entry, no scroll and no server render. A mode the step can't
   * show is not chosen on it. Choosing the mode on screen again, when no
   * `?view` named it, only stores it: nothing changes on screen, so nothing
   * is written. While a navigation to another step is on its way, that
   * navigation takes the mode instead (R20); while the step on screen's own
   * route is (a step change by ←/→), the mode goes with it, as a replace to
   * that step. In the ignore-region editor, Swipe and Flicker wait for it to
   * close, and side by side shows meanwhile (R3, spec §4.4).
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
 * which hands `view`, `setMode` and `available` to its parts
 * (`ViewerModeProvider`). It also keeps the ignore-region editor's override
 * (R3).
 */
export function useViewerMode({
  urlView,
  hasBaseline,
  step,
  path,
  retarget,
}: ViewerModeInput): ViewerModeState {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  // The view `setMode` last wrote, and the URL's view when it did. Next
  // applies a history write to `useSearchParams` in a transition, after the
  // render that shows the mode (and a write that goes with a step change, or
  // a retargeted move, lands only with that step's route); until the URL's
  // view changes, what was written is the view. Then it is dropped for good,
  // and the URL's is (it caught up, or another URL came).
  const [written, setWritten] = useState<{
    view: ViewerMode;
    over: ViewerMode | null;
  } | null>(null);
  if (written !== null && written.over !== urlView) setWritten(null);
  const view =
    written !== null && written.over === urlView ? written.view : urlView;
  const mode = useModeFor(view, hasBaseline);

  // The newest query string we know of: the URL's, or the one the last
  // change wrote before Next re-rendered us with it.
  const latest = useRef(search);
  useEffect(() => {
    latest.current = search;
  }, [search]);
  // What `setMode` acts on when it is called, not when it was made.
  const inputs = {
    urlView,
    view,
    hasBaseline,
    path: path ?? pathname,
    route: pathname,
    retarget,
  };
  const live = useRef(inputs);
  live.current = inputs;

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
      // In the editor, the mode it can draw on shows now; Swipe and Flicker
      // wait, as side by side, for it to close (R3, spec §4.4).
      if (editorOpen()) setEditorOverride(editorOverrideFor(next));
      // Nothing to write: the URL names it already, or it is the mode on
      // screen and no `?view` chose it (M2). Only the preference changes.
      if (now.view === next || (now.view === null && from === next)) return;
      setWritten({ view: next, over: now.urlView });
      // On the way to another step: the navigation takes the mode with it,
      // and this step's URL is not written (that would call it off, R20).
      if (now.retarget?.(next)) return;
      const params = new URLSearchParams(latest.current);
      params.set("view", next);
      latest.current = params.toString();
      const url = `${now.path}?${latest.current}${window.location.hash}`;
      // The step on screen's route is still on its way (←/→): the mode goes
      // with it. A history write now would call that navigation off, and
      // leave the step's URL over the route it left.
      if (now.path !== now.route) {
        router.replace(url, { scroll: false });
        return;
      }
      // R31: a history write, which Next applies to `useSearchParams`. No
      // navigation, so the server page isn't rendered again for a mode.
      window.history.replaceState(null, "", url);
    },
    [router],
  );

  // R3, spec §4.4: the editor's override, kept in line with the editor and
  // the mode chosen for the step on screen. Opened on Swipe or Flicker, the
  // editor shows side by side; closed (Esc, I, Done), the chosen mode is
  // back, as nothing else changed. It follows the editor at once, in the
  // store's own change, so no frame shows the editor on Swipe or Flicker.
  // It is the step's and this viewer's: a step change clears it, and so does
  // the viewer going, so it never outlives what it was set for (M4).
  useLayoutEffect(() => {
    const apply = () => {
      const { view: shown, hasBaseline: baseline } = live.current;
      const chosen = effectiveMode({
        editorOverride: null,
        urlView: shown,
        preferred: useViewerPrefs.getState().prefs.mode,
        hasBaseline: baseline,
      });
      setEditorOverride(editorOpen() ? editorOverrideFor(chosen) : null);
    };
    apply();
    const off = useViewerStore.subscribe((s, prev) => {
      if (s.ignoreEditMode !== prev.ignoreEditMode) apply();
    });
    return () => {
      off();
      setEditorOverride(null);
    };
  }, [step, view, hasBaseline]);

  const available = useMemo(() => availableModes(hasBaseline), [hasBaseline]);

  return { mode, available, setMode, view };
}
