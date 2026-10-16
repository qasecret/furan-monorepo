import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { tinykeys } from "tinykeys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock, undoMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  undoMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: undoMock }),
}));
vi.mock("tinykeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tinykeys")>();
  return { ...actual, tinykeys: vi.fn(actual.tinykeys) };
});

import { createBackend, TrpcBackend } from "./trpc-backend";

import { CurrentProjectProvider } from "@/app/(protected)/_components/current-project-provider";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { useDiffViewerShortcuts } from "@/components/diff-viewer/useDiffViewerShortcuts";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import {
  TourProvider,
  useTour,
  useTourSteps,
  type TourStep,
} from "@/components/tour/tour-context";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import {
  SINGLE_KEYS_STORAGE_KEY,
  useSingleKeyStore,
} from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  resolveCommands,
  useCommandRegistry,
  type ResolvedCommand,
} from "@/lib/commands/registry";
import { useReviewAnnouncer } from "@/lib/review/review-announcer";
import { useUndoStore } from "@/lib/review/use-undo-store";
import type { ViewerRole } from "@/lib/roles";

// next-themes reads the OS scheme through matchMedia, which jsdom lacks.
function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/** The protected layout's keyboard part, with whatever the test adds. */
function Layout({
  role = "editor",
  children,
}: {
  role?: ViewerRole;
  children?: ReactNode;
}) {
  return (
    <CommandRoleProvider role={role}>
      <GlobalCommands />
      <CommandDispatcher />
      {children}
    </CommandRoleProvider>
  );
}

/** A keydown on the focused element, as the browser sends it. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(e);
  });
  return e;
}

/**
 * The keys the dispatcher's latest bind holds: one bind is two tinykeys maps,
 * the sequences' then the single keys' (R10).
 */
function boundKeys(): string[] {
  return vi
    .mocked(tinykeys)
    .mock.calls.slice(-2)
    .flatMap((call) => Object.keys(call[1]));
}

function find(id: string): ResolvedCommand | undefined {
  return resolveCommands().find((c) => c.command.id === id);
}

/** Runs a command as the palette will: by id, with its live ctx. */
async function runCommand(id: string) {
  const resolved = find(id);
  if (!resolved) throw new Error(`${id} is not registered`);
  await act(async () => {
    await resolved.command.run(resolved.ctx());
  });
}

function isEnabled(id: string): boolean {
  const resolved = find(id);
  if (!resolved) throw new Error(`${id} is not registered`);
  return resolved.command.enabled?.(resolved.ctx()) ?? true;
}

/** ⌘Z takes back this session's newest review action: there is one. */
function haveSomethingToUndo() {
  useUndoStore.setState({
    stack: [{ actionId: "a1", label: "Approved home", runIds: ["r1"] }],
  });
}

beforeEach(() => {
  useUndoStore.setState({ stack: [] });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  usePaletteStore.setState({ open: false });
  useShortcutsSheet.setState({ open: false });
  useReviewAnnouncer.setState({ text: "", seq: 0 });
  pushMock.mockReset();
  undoMock.mockReset();
  vi.mocked(tinykeys).mockClear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.className = "";
  document.body.innerHTML = "";
});

describe("GlobalCommands", () => {
  it("registers spec §4.1's commands with their labels and keys", () => {
    render(<Layout role="admin" />);
    const table = Object.fromEntries(
      resolveCommands().map(({ command, scope }) => [
        command.id,
        { label: command.label, keys: command.keys ?? [], scope },
      ]),
    );
    expect(table).toEqual({
      "palette.open": {
        label: "Open command palette",
        keys: ["$mod+k"],
        scope: "global",
      },
      "help.shortcuts": {
        label: "Keyboard shortcuts",
        keys: ["?"],
        scope: "global",
      },
      "search.focus": { label: "Search", keys: ["/"], scope: "global" },
      "review.undo": {
        label: "Undo last review action",
        keys: ["$mod+z"],
        scope: "global",
      },
      "go.batches": { label: "Go to Batches", keys: ["g i"], scope: "global" },
      "go.analytics": {
        label: "Go to Analytics",
        keys: ["g a"],
        scope: "global",
      },
      "go.projects": {
        label: "Go to Projects",
        keys: ["g p"],
        scope: "global",
      },
      "pref.theme": { label: "Toggle theme", keys: [], scope: "global" },
      "pref.singleKeysOff": {
        label: "Turn single-key shortcuts off",
        keys: [],
        scope: "global",
      },
      "pref.singleKeysOn": {
        label: "Turn single-key shortcuts on",
        keys: [],
        scope: "global",
      },
      "help.tour": { label: "Replay tour", keys: [], scope: "global" },
    });
  });

  it("g i goes to /inbox", () => {
    render(<Layout role="guest" />);
    press("g");
    const e = press("i");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/inbox");
    expect(e.defaultPrevented).toBe(true);
  });

  it("g then i more than a second later does not navigate", () => {
    vi.useFakeTimers();
    try {
      render(<Layout />);
      press("g");
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      press("i");
      expect(pushMock).not.toHaveBeenCalled();

      // Within the second it does.
      press("g");
      act(() => {
        vi.advanceTimersByTime(900);
      });
      press("i");
      expect(pushMock).toHaveBeenCalledWith("/inbox");
    } finally {
      vi.useRealTimers();
    }
  });

  it("g i typed into a text field does not navigate", () => {
    render(
      <Layout>
        <input aria-label="Branch" />
      </Layout>,
    );
    act(() => screen.getByRole("textbox", { name: "Branch" }).focus());
    press("g");
    const i = press("i");
    expect(pushMock).not.toHaveBeenCalled();
    expect(i.defaultPrevented).toBe(false);
  });

  it("? opens the Keyboard shortcuts sheet", () => {
    render(<Layout role="guest" />);
    expect(useShortcutsSheet.getState().open).toBe(false);
    const e = press("?", { shiftKey: true });
    expect(useShortcutsSheet.getState().open).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it("/ opens the palette when no page search is registered", () => {
    render(<Layout role="editor" />);
    expect(usePaletteStore.getState().open).toBe(false);
    const e = press("/");
    expect(usePaletteStore.getState().open).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it("g a and g p are admin-only", () => {
    // An editor: no navigation, no binding, no command.
    const editor = render(<Layout role="editor" />);
    for (const key of ["a", "p"]) {
      press("g");
      press(key);
    }
    expect(pushMock).not.toHaveBeenCalled();
    expect(boundKeys()).not.toEqual(expect.arrayContaining(["g a"]));
    const bound = boundKeys();
    expect(bound).toContain("g i");
    expect(bound).not.toContain("g a");
    expect(bound).not.toContain("g p");
    expect(find("go.analytics")).toBeUndefined();
    expect(find("go.projects")).toBeUndefined();
    editor.unmount();

    // An admin, and an owner (who passes every admin gate).
    for (const role of ["admin", "owner"] as const) {
      pushMock.mockReset();
      const tree = render(<Layout role={role} />);
      press("g");
      press("a");
      expect(pushMock, role).toHaveBeenLastCalledWith("/analytics");
      press("g");
      press("p");
      expect(pushMock, role).toHaveBeenLastCalledWith("/projects");
      expect(pushMock).toHaveBeenCalledTimes(2);
      tree.unmount();
    }
  });

  it("⌘K opens the palette but not over an open dialog; inside the palette ⌘K closes it", async () => {
    render(
      <Layout>
        <CurrentProjectProvider
          initialProjects={[]}
          initialDefaultProjectId={null}
        >
          <TrpcBackend backend={createBackend()}>
            <CommandPalette userRole="editor" userId="u1" />
          </TrpcBackend>
        </CurrentProjectProvider>
      </Layout>,
    );

    // jsdom is not a Mac: $mod is Ctrl.
    const opened = press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(true);
    expect(opened.defaultPrevented).toBe(true);
    const palette = await screen.findByTestId("command-palette");
    expect(palette.hasAttribute("data-command-palette")).toBe(true);

    // Its search box has focus: ⌘K there closes it.
    const input = screen.getByTestId("command-input");
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    const closed = press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(false);
    expect(closed.defaultPrevented).toBe(true);
    cleanup();

    // Another dialog is open, with focus in it: ⌘K leaves it alone.
    render(
      <Layout>
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Approve pending</DialogTitle>
            <button type="button">Cancel</button>
          </DialogContent>
        </Dialog>
      </Layout>,
    );
    act(() => screen.getByRole("button", { name: "Cancel" }).focus());
    const over = press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(false);
    expect(over.defaultPrevented).toBe(false);
  });

  it("⌘K opens the palette from a focused text field", () => {
    render(
      <Layout>
        <input aria-label="Search batches" />
      </Layout>,
    );
    act(() => screen.getByRole("textbox", { name: "Search batches" }).focus());

    const e = press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });

  it("⌘Z calls undo", () => {
    haveSomethingToUndo();
    render(
      <Layout role="editor">
        <div role="dialog" data-passes-undo="">
          <button type="button">Back to batch</button>
        </div>
        <div role="dialog">
          <button type="button">Keep</button>
        </div>
      </Layout>,
    );

    const e = press("z", { ctrlKey: true });
    expect(undoMock).toHaveBeenCalledTimes(1);
    // The newest action: no id.
    expect(undoMock).toHaveBeenCalledWith();
    expect(e.defaultPrevented).toBe(true);

    // Held down, it undoes once; ⇧⌘Z (redo) is not undo.
    press("z", { ctrlKey: true, repeat: true });
    press("z", { ctrlKey: true, shiftKey: true });
    expect(undoMock).toHaveBeenCalledTimes(1);

    // The done card passes ⌘Z through; another dialog keeps it.
    act(() => screen.getByRole("button", { name: "Back to batch" }).focus());
    press("z", { ctrlKey: true });
    expect(undoMock).toHaveBeenCalledTimes(2);
    act(() => screen.getByRole("button", { name: "Keep" }).focus());
    press("z", { ctrlKey: true });
    expect(undoMock).toHaveBeenCalledTimes(2);
  });

  it("⌘Z with nothing to undo does nothing and leaves the key alone", () => {
    // R16: the command is enabled while this session has an action to take
    // back, which the palette lists it by.
    render(<Layout role="editor" />);
    expect(isEnabled("review.undo")).toBe(false);
    const e = press("z", { ctrlKey: true });
    expect(undoMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);

    act(() => haveSomethingToUndo());
    expect(isEnabled("review.undo")).toBe(true);
    expect(press("z", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(undoMock).toHaveBeenCalledTimes(1);
  });

  it("a guest has no ⌘Z binding and no undo row", () => {
    // R9: undo takes back a review decision, which a guest cannot make.
    haveSomethingToUndo();
    render(<Layout role="guest" />);
    expect(find("review.undo")).toBeUndefined();
    const bound = boundKeys();
    expect(bound).not.toContain("$mod+z");
    expect(bound).toContain("$mod+k");
    const e = press("z", { ctrlKey: true });
    expect(undoMock).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    cleanup();

    // Every role that reviews has it.
    for (const role of ["editor", "admin", "owner"] as const) {
      render(<Layout role={role} />);
      expect(find("review.undo"), role).toBeDefined();
      cleanup();
    }
  });

  it("⌘Z in a text field is native undo, not review undo", () => {
    haveSomethingToUndo();
    render(
      <Layout>
        <input aria-label="Branch" />
        <textarea aria-label="Reason" />
      </Layout>,
    );
    for (const name of ["Branch", "Reason"]) {
      act(() => screen.getByRole("textbox", { name }).focus());
      const e = press("z", { ctrlKey: true });
      expect(undoMock, name).not.toHaveBeenCalled();
      expect(e.defaultPrevented, name).toBe(false);
    }
  });

  it("⌘Z undoes once with the viewer mounted", () => {
    // The viewer's keys are registry commands and ⌘Z is not one of them: on
    // its page ⌘Z is this undo, once, whichever mounts first.
    haveSomethingToUndo();
    const viewer = () =>
      renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    const layout = () => render(<Layout />);

    for (const [first, second] of [
      [layout, viewer],
      [viewer, layout],
    ] as const) {
      undoMock.mockReset();
      first();
      second();
      press("z", { ctrlKey: true });
      expect(undoMock).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("Toggle theme flips light/dark", async () => {
    stubMatchMedia();
    localStorage.setItem("furan-theme", "light");
    render(
      <ThemeProvider>
        <Layout />
      </ThemeProvider>,
    );
    await act(async () => undefined);
    expect(document.documentElement.classList.contains("light")).toBe(true);

    await runCommand("pref.theme");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("furan-theme")).toBe("dark");

    await runCommand("pref.theme");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(localStorage.getItem("furan-theme")).toBe("light");
  });

  it("the single-key switch commands: only the one that applies is enabled", async () => {
    render(<Layout />);

    // On (the default): only "off" is offered.
    expect(isEnabled("pref.singleKeysOff")).toBe(true);
    expect(isEnabled("pref.singleKeysOn")).toBe(false);

    await runCommand("pref.singleKeysOff");
    expect(useSingleKeyStore.getState().on).toBe(false);
    expect(localStorage.getItem(SINGLE_KEYS_STORAGE_KEY)).toBe("0");
    expect(useReviewAnnouncer.getState().text).toBe("Single-key shortcuts off");
    expect(isEnabled("pref.singleKeysOff")).toBe(false);
    expect(isEnabled("pref.singleKeysOn")).toBe(true);

    await runCommand("pref.singleKeysOn");
    expect(useSingleKeyStore.getState().on).toBe(true);
    expect(useReviewAnnouncer.getState().text).toBe("Single-key shortcuts on");
  });

  it("Replay tour is enabled only when the page has a tour, and relaunches it", async () => {
    // No TourProvider (an isolated shell): disabled, and running it is safe.
    const bare = render(<Layout />);
    expect(isEnabled("help.tour")).toBe(false);
    await runCommand("help.tour");
    bare.unmount();

    // A provider, but no page tour yet.
    const steps: TourStep[] = [{ target: "body", content: "Hello" }];
    let tour: ReturnType<typeof useTour> | undefined;
    function Probe({ register }: { register: boolean }) {
      tour = useTour();
      return register ? <Registers /> : null;
    }
    function Registers() {
      useTourSteps("inbox", steps);
      return null;
    }
    // Dismissed before: it registers without starting.
    localStorage.setItem("furan:tour:dismissed:inbox", "1");
    const tree = render(
      <TourProvider>
        <Layout />
        <Probe register={false} />
      </TourProvider>,
    );
    expect(isEnabled("help.tour")).toBe(false);

    tree.rerender(
      <TourProvider>
        <Layout />
        <Probe register />
      </TourProvider>,
    );
    expect(tour?.state.pageId).toBe("inbox");
    expect(tour?.state.active).toBe(false);
    expect(isEnabled("help.tour")).toBe(true);

    await runCommand("help.tour");
    expect(tour?.state.active).toBe(true);
    expect(tour?.state.index).toBe(0);
  });

  it("Replay tour follows the current page: it is off again once the page with a tour is left", async () => {
    const steps: TourStep[] = [{ target: "body", content: "Hello" }];
    function Page({ id }: { id: string }) {
      useTourSteps(id, steps);
      return null;
    }
    const shell = (page: ReactNode) => (
      <TourProvider>
        <Layout />
        {page}
      </TourProvider>
    );
    localStorage.setItem("furan:tour:dismissed:inbox", "1");
    localStorage.setItem("furan:tour:dismissed:variations", "1");

    const view = render(shell(<Page id="inbox" />));
    expect(isEnabled("help.tour")).toBe(true);

    // To a page that has no tour of its own.
    view.rerender(shell(null));
    expect(isEnabled("help.tour")).toBe(false);

    // To one that has: it is that page's tour that replays.
    view.rerender(shell(<Page id="variations" />));
    expect(isEnabled("help.tour")).toBe(true);
  });
});
