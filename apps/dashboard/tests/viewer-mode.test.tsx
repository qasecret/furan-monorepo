import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The URL the viewer is on, and its router, set per test.
const nav = vi.hoisted(() => ({
  pathname: "",
  search: "",
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  useDiffViewerShortcuts,
  type ShortcutOptions,
} from "@/components/diff-viewer/useDiffViewerShortcuts";
import {
  effectiveMode,
  parseViewParam,
  setEditorOverride,
  useEffectiveMode,
  useViewerMode,
  ViewerModeProvider,
} from "@/components/diff-viewer/viewer-mode";
import {
  DEFAULT_VIEWER_PREFS,
  prefsKey,
  readViewerPrefs,
  useViewerPrefs,
  VIEWER_MODES,
  type ViewerMode,
} from "@/components/diff-viewer/viewer-prefs";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  resolveCommands,
  useCommandRegistry,
} from "@/lib/commands/registry";

const STEP = "/projects/p1/runs/r1/checkpoints/c1";
/** The review context the step's URL carries (spec §3.3). */
const CONTEXT = "status=failed&os=macOS";

/** The stored preference of the user "u1". */
const stored = () => readViewerPrefs("u1").mode;
/** Nothing of the user's has been written to storage. */
const nothingStored = () => localStorage.getItem(prefsKey("u1")) === null;

beforeEach(() => {
  localStorage.clear();
  nav.pathname = STEP;
  nav.search = CONTEXT;
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  // The user's preferences, read from an empty storage: the defaults.
  useViewerPrefs.setState({
    userId: null,
    prefs: DEFAULT_VIEWER_PREFS,
    previousMode: "side-by-side",
  });
  useViewerPrefs.getState().hydrate("u1");
  setEditorOverride(null);
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setEditorOverride(null);
  localStorage.clear();
});

/** The preference, set as a reviewer's earlier visit stored it. */
function prefer(mode: ViewerMode) {
  act(() => useViewerPrefs.getState().set("mode", mode));
  nav.router.replace.mockReset();
}

describe("parseViewParam", () => {
  test.each(VIEWER_MODES)("?view=%s names that mode", (mode) => {
    expect(parseViewParam(mode)).toBe(mode);
  });

  test("anything else is no view: ignored, never an error", () => {
    for (const v of [
      "bogus",
      "",
      "Swipe",
      "difference",
      undefined,
      // A repeated param names no one mode.
      ["swipe", "diff"],
    ]) {
      expect(parseViewParam(v)).toBeNull();
    }
  });
});

describe("effectiveMode: the editor's override, then ?view, then the preference (R3)", () => {
  const inputs = {
    editorOverride: null,
    urlView: null,
    preferred: "side-by-side",
    hasBaseline: true,
  } as const;

  test("?view outranks the preference", () => {
    expect(
      effectiveMode({ ...inputs, urlView: "overlay", preferred: "diff" }),
    ).toBe("overlay");
  });

  test("with no ?view, the preference", () => {
    expect(effectiveMode({ ...inputs, preferred: "diff" })).toBe("diff");
  });

  test("the editor's override outranks both", () => {
    expect(
      effectiveMode({
        ...inputs,
        editorOverride: "side-by-side",
        urlView: "swipe",
        preferred: "flicker",
      }),
    ).toBe("side-by-side");
  });

  test("a mode the step can't show (no baseline) is side by side, from any source", () => {
    for (const mode of VIEWER_MODES) {
      const noBaseline = { ...inputs, hasBaseline: false };
      expect(effectiveMode({ ...noBaseline, preferred: mode })).toBe(
        "side-by-side",
      );
      expect(effectiveMode({ ...noBaseline, urlView: mode })).toBe(
        "side-by-side",
      );
      expect(effectiveMode({ ...noBaseline, editorOverride: mode })).toBe(
        "side-by-side",
      );
    }
  });
});

describe("useViewerMode", () => {
  type Input = Parameters<typeof useViewerMode>[0];
  function viewer(input: Partial<Input> = {}) {
    return renderHook((props: Input) => useViewerMode(props), {
      initialProps: { urlView: null, hasBaseline: true, ...input },
    });
  }

  test("precedence: ?view=overlay over a stored diff; with no ?view, the preference", () => {
    prefer("diff");
    expect(viewer({ urlView: "overlay" }).result.current.mode).toBe("overlay");
    expect(viewer({ urlView: null }).result.current.mode).toBe("diff");
  });

  test("setMode stores the preference and replaces the URL once, with view and every other param as they were", () => {
    const { result } = viewer();
    act(() => result.current.setMode("swipe"));
    expect(nav.router.replace).toHaveBeenCalledOnce();
    expect(nav.router.replace).toHaveBeenCalledWith(
      `${STEP}?${CONTEXT}&view=swipe`,
      { scroll: false },
    );
    // No history entry.
    expect(nav.router.push).not.toHaveBeenCalled();
    expect(stored()).toBe("swipe");
    // On screen at once: the router re-renders the page with the new URL
    // only after a round trip.
    expect(result.current.mode).toBe("swipe");
    expect(result.current.view).toBe("swipe");
  });

  test("a view already in the URL is changed where it stands", () => {
    nav.search = `view=overlay&${CONTEXT}&utm_source=mail`;
    const { result } = viewer({ urlView: "overlay" });
    act(() => result.current.setMode("diff"));
    expect(nav.router.replace).toHaveBeenCalledWith(
      `${STEP}?view=diff&${CONTEXT}&utm_source=mail`,
      { scroll: false },
    );
  });

  test("two changes before the URL catches up: the second builds on the first", () => {
    const { result } = viewer();
    act(() => result.current.setMode("swipe"));
    act(() => result.current.setMode("diff"));
    expect(nav.router.replace).toHaveBeenCalledTimes(2);
    expect(nav.router.replace).toHaveBeenLastCalledWith(
      `${STEP}?${CONTEXT}&view=diff`,
      { scroll: false },
    );
    expect(result.current.mode).toBe("diff");
  });

  test("the URL catching up keeps the mode; a later URL's view is the one shown", () => {
    const { result, rerender } = viewer({ urlView: "overlay" });
    act(() => result.current.setMode("swipe"));
    rerender({ urlView: "swipe", hasBaseline: true });
    expect(result.current.mode).toBe("swipe");
    // The page is opened again on another view (a link to the same step).
    rerender({ urlView: "flicker", hasBaseline: true });
    expect(result.current.mode).toBe("flicker");
    expect(result.current.view).toBe("flicker");
  });

  test("once the URL has caught up, what was written is dropped: a later URL with no view has none", () => {
    const { result, rerender } = viewer({ urlView: null });
    act(() => result.current.setMode("swipe"));
    expect(result.current.view).toBe("swipe");
    rerender({ urlView: "swipe", hasBaseline: true });
    // The same step opened again from elsewhere (a link carries no view).
    rerender({ urlView: null, hasBaseline: true });
    expect(result.current.view).toBeNull();
    // The preference it stored still shows.
    expect(result.current.mode).toBe("swipe");
  });

  test("selecting the mode the URL already shows stores it, and leaves the URL alone", () => {
    const { result } = viewer({ urlView: "overlay" });
    act(() => result.current.setMode("overlay"));
    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(stored()).toBe("overlay");
  });

  test("while a step change is on its way, the URL written is that step's", () => {
    const next = "/projects/p1/runs/r1/checkpoints/c2";
    const { result } = viewer({ path: next });
    act(() => result.current.setMode("diff"));
    expect(nav.router.replace).toHaveBeenCalledWith(
      `${next}?${CONTEXT}&view=diff`,
      { scroll: false },
    );
  });

  test("d's way back from Diff is the mode left on screen, even when ?view chose it", () => {
    // Stored side by side; the link opened Overlay.
    const { result } = viewer({ urlView: "overlay" });
    act(() => result.current.setMode("diff"));
    expect(useViewerPrefs.getState().previousMode).toBe("overlay");
  });

  test("Review Focus 4: ?view=swipe on a step with no baseline shows side by side, and changes neither the URL nor the preference", () => {
    const { result, rerender } = viewer({
      urlView: "swipe",
      hasBaseline: false,
    });
    expect(result.current.mode).toBe("side-by-side");
    expect(result.current.available).toEqual({
      "side-by-side": true,
      swipe: false,
      flicker: false,
      overlay: false,
      diff: false,
    });
    // The links keep the reviewer's choice for the steps that can show it.
    expect(result.current.view).toBe("swipe");
    // A mode the step can't show is not chosen on it, by any route.
    act(() => result.current.setMode("overlay"));
    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(nothingStored()).toBe(true);

    // The next step has a baseline: Swipe again.
    rerender({ urlView: "swipe", hasBaseline: true });
    expect(result.current.mode).toBe("swipe");
    expect(result.current.available).toEqual({
      "side-by-side": true,
      swipe: true,
      flicker: true,
      overlay: true,
      diff: true,
    });
    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(nothingStored()).toBe(true);
  });

  test("the editor's override (R3) outranks ?view and the preference, and is never stored or written to the URL", () => {
    prefer("overlay");
    const { result } = viewer({ urlView: "swipe" });
    expect(result.current.mode).toBe("swipe");
    act(() => setEditorOverride("side-by-side"));
    expect(result.current.mode).toBe("side-by-side");
    expect(result.current.view).toBe("swipe");
    expect(nav.router.replace).not.toHaveBeenCalled();
    expect(stored()).toBe("overlay");
    act(() => setEditorOverride(null));
    expect(result.current.mode).toBe("swipe");
  });
});

describe("the viewer's parts read the one effective mode", () => {
  function Probe({ hasBaseline = true }: { hasBaseline?: boolean }) {
    return <output data-testid="mode">{useEffectiveMode(hasBaseline)}</output>;
  }
  const shown = () => document.querySelector("output")?.textContent;

  test("inside the viewer, the URL's view; outside one, the preference", () => {
    prefer("diff");
    render(
      <ViewerModeProvider value={{ view: "overlay", setMode: vi.fn() }}>
        <Probe />
      </ViewerModeProvider>,
    );
    expect(shown()).toBe("overlay");
    cleanup();
    render(<Probe />);
    expect(shown()).toBe("diff");
  });

  test("the same fallback and override as the viewer's", () => {
    render(
      <ViewerModeProvider value={{ view: "swipe", setMode: vi.fn() }}>
        <Probe hasBaseline={false} />
      </ViewerModeProvider>,
    );
    expect(shown()).toBe("side-by-side");
    cleanup();
    render(
      <ViewerModeProvider value={{ view: "swipe", setMode: vi.fn() }}>
        <Probe />
      </ViewerModeProvider>,
    );
    act(() => setEditorOverride("side-by-side"));
    expect(shown()).toBe("side-by-side");
  });
});

describe("the viewer's mode keys read the effective mode (Task 10 M3)", () => {
  function Keys(opts: ShortcutOptions) {
    useDiffViewerShortcuts(opts);
    return null;
  }
  function mount(opts: Partial<ShortcutOptions> = {}) {
    render(
      <CommandRoleProvider role="editor">
        <CommandDispatcher />
        <Keys viewports={[]} {...opts} />
      </CommandRoleProvider>,
    );
  }
  function enabled(id: string): boolean {
    const found = resolveCommands().find((c) => c.command.id === id);
    if (!found) throw new Error(`no ${id}`);
    return found.command.enabled?.(found.ctx()) ?? true;
  }
  function press(key: string): KeyboardEvent {
    const e = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(e);
    });
    return e;
  }

  test("?view=flicker over a stored Overlay: f is on", () => {
    prefer("overlay");
    mount({ urlView: "flicker" });
    expect(enabled("viewer.flicker.toggle")).toBe(true);
    expect(press("f").defaultPrevented).toBe(true);
  });

  test("?view=overlay over a stored Flicker: f is off, and the key is the page's", () => {
    prefer("flicker");
    mount({ urlView: "overlay" });
    expect(enabled("viewer.flicker.toggle")).toBe(false);
    expect(press("f").defaultPrevented).toBe(false);
  });

  test("the editor's override turns f off; cleared, on again", () => {
    prefer("flicker");
    mount();
    expect(enabled("viewer.flicker.toggle")).toBe(true);
    act(() => setEditorOverride("side-by-side"));
    expect(enabled("viewer.flicker.toggle")).toBe(false);
    act(() => setEditorOverride(null));
    expect(enabled("viewer.flicker.toggle")).toBe(true);
  });

  test("?view=flicker on a step with no baseline: f is off", () => {
    mount({ urlView: "flicker", hasBaseline: false });
    expect(enabled("viewer.flicker.toggle")).toBe(false);
  });

  test("d and o change the mode on screen through the viewer's setMode: the URL's, not only the preference", () => {
    const setMode = vi.fn();
    // Stored side by side; the URL shows Overlay.
    mount({ urlView: "overlay", setMode });
    press("o");
    expect(setMode).toHaveBeenLastCalledWith("diff");
    press("d");
    expect(setMode).toHaveBeenLastCalledWith("diff");
    expect(stored()).toBe("side-by-side");
  });
});
