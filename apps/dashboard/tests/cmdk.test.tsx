/**
 * The ⌘K command palette (spec §5.2): its groups and their order, the page's
 * actions from the command registry, human Go to labels, admin-only project
 * jumps, Recent per user, the live result count, and the guard keeping the
 * typed letters the search's (Review Focus 3).
 *
 * It is mounted as the protected layout mounts it: inside the role provider
 * and the current project, with the global commands and the one dispatcher.
 * The shared tests/setup.ts shims keep Radix Dialog happy in jsdom.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createBackend, TrpcBackend } from "./trpc-backend";

const { pushMock, undoMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  undoMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The global commands' ⌘Z: no review session here.
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: undoMock }),
}));

import {
  CurrentProjectProvider,
  type ProjectListItem,
} from "@/app/(protected)/_components/current-project-provider";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import {
  useDiffViewerShortcuts,
  type ShortcutOptions,
} from "@/components/diff-viewer/useDiffViewerShortcuts";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  useCommandRegistry,
  useCommands,
} from "@/lib/commands/registry";
import type { Command } from "@/lib/commands/types";
import { useUndoStore } from "@/lib/review/use-undo-store";
import type { ViewerRole } from "@/lib/roles";

const PROJECTS: ProjectListItem[] = [
  { id: "p1", name: "Acme" },
  { id: "p2", name: "Beta" },
];

const RECENT_A = "furan:palette:recent:user-a";

/** The palette's search asks this server, which has nothing to show. */
const backend = createBackend();

/** The protected layout's keyboard and palette, around a page. */
function Shell({
  role = "editor",
  userId = "user-a",
  projects = PROJECTS,
  defaultProjectId = "p1",
  children,
}: {
  role?: ViewerRole;
  userId?: string;
  projects?: ProjectListItem[];
  defaultProjectId?: string | null;
  children?: ReactNode;
}) {
  return (
    <TrpcBackend backend={backend}>
      <CommandRoleProvider role={role}>
        <CurrentProjectProvider
          initialProjects={projects}
          initialDefaultProjectId={defaultProjectId}
        >
          <GlobalCommands />
          <CommandDispatcher />
          {children}
          <CommandPalette userRole={role} userId={userId} />
        </CurrentProjectProvider>
      </CommandRoleProvider>
    </TrpcBackend>
  );
}

/** The diff viewer's page commands, registered as the viewer does. */
function Viewer(opts: ShortcutOptions) {
  useDiffViewerShortcuts(opts);
  return null;
}

async function openPalette(): Promise<HTMLElement> {
  act(() => usePaletteStore.getState().setOpen(true));
  return screen.findByTestId("command-palette");
}

/** The group headings, in the order they render. */
function headings(palette: HTMLElement): string[] {
  return [...palette.querySelectorAll("[cmdk-group-heading]")].map(
    (h) => h.textContent ?? "",
  );
}

function group(palette: HTMLElement, heading: string): HTMLElement {
  return within(palette).getByRole("group", { name: heading });
}

/** Each option's label (its keys are a separate, hidden part). */
function labels(palette: HTMLElement, heading: string): string[] {
  return within(group(palette, heading))
    .queryAllByRole("option")
    .map((o) => o.firstElementChild?.textContent ?? "");
}

/** The key caps shown on an option, one string per `kbd` cap. */
function caps(option: HTMLElement): string[] {
  return [...option.querySelectorAll("kbd kbd")].map(
    (k) => k.textContent ?? "",
  );
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

/**
 * Lets the palette finish closing: Radix hands focus back a tick after its
 * content unmounts, and a picked command runs then.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * What a screen reader is told is chosen: the search box (and the list) name
 * the one row that is chosen, by its id. cmdk keeps that name only when its
 * own select runs, so a row chosen any other way is chosen but not named.
 */
function expectNamesChosenRow(palette: HTMLElement) {
  const chosen = palette.querySelectorAll(
    '[role="option"][aria-selected="true"]',
  );
  // One row is chosen, or none (no results); never more.
  expect(chosen.length).toBeLessThanOrEqual(1);
  const id = chosen[0]?.id ?? null;
  expect(
    screen.getByTestId("command-input").getAttribute("aria-activedescendant"),
  ).toBe(id);
  expect(
    palette
      .querySelector("[cmdk-list]")
      ?.getAttribute("aria-activedescendant") ?? null,
  ).toBe(id);
}

beforeEach(() => {
  backend.calls = [];
  pushMock.mockReset();
  undoMock.mockReset();
  useUndoStore.setState({ stack: [] });
  usePaletteStore.setState({ open: false });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  useShortcutsSheet.setState({ open: false });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  usePaletteStore.setState({ open: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CommandPalette", () => {
  test("$mod+K opens it and, from its search box, closes it", async () => {
    // The palette has no key listener of its own: the layout's dispatcher
    // runs `palette.open`.
    render(<Shell />);
    expect(usePaletteStore.getState().open).toBe(false);

    // jsdom is not a Mac: $mod is Ctrl.
    press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(true);

    // Pressed in its search box, where cmdk's own key handling sees it first.
    const input = await screen.findByTestId("command-input");
    act(() => input.focus());
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(usePaletteStore.getState().open).toBe(false);
  });

  test("has no key listener of its own", () => {
    render(
      <CurrentProjectProvider
        initialProjects={[]}
        initialDefaultProjectId={null}
      >
        <CommandPalette userRole="editor" userId="user-a" />
      </CurrentProjectProvider>,
    );
    // One press at a time: two would toggle it back.
    press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(false);
    press("k", { metaKey: true });
    expect(usePaletteStore.getState().open).toBe(false);
  });

  test("closes on Escape", async () => {
    render(<Shell />);
    await openPalette();

    // Radix Dialog handles Escape via its own keydown listener on the
    // content element. Dispatch on document so the listener picks it up.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await waitFor(() => {
      expect(usePaletteStore.getState().open).toBe(false);
    });
  });

  test("shows the spec's placeholder", async () => {
    render(<Shell />);
    await openPalette();
    expect(
      screen.getByTestId("command-input").getAttribute("placeholder"),
    ).toBe("Search batches and tests, or run a command…");
  });

  test("groups appear in spec order", async () => {
    localStorage.setItem(
      RECENT_A,
      JSON.stringify([{ id: "admin.members", label: "Members" }]),
    );
    render(
      <Shell role="admin">
        <Viewer viewports={[]} onNextDiff={vi.fn()} />
      </Shell>,
    );
    const palette = await openPalette();
    expect(headings(palette)).toEqual([
      "Actions",
      "Go to",
      "Recent",
      "Projects",
      "Preferences",
      "Account",
    ]);
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));

    // An editor on a page without commands, nothing recent: the empty and
    // admin-only groups are left out, the rest keep their order.
    localStorage.clear();
    render(<Shell role="editor" />);
    expect(headings(await openPalette())).toEqual([
      "Go to",
      "Preferences",
      "Account",
    ]);
  });

  test("Actions lists the page's enabled commands with their keys and runs one", async () => {
    // Whether the palette was still open when the command ran.
    const openWhenRun: boolean[] = [];
    const onApprove = vi.fn(() => {
      openWhenRun.push(usePaletteStore.getState().open);
    });
    render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={onApprove} onPrevStep={vi.fn()} />
      </Shell>,
    );
    const palette = await openPalette();
    const actions = labels(palette, "Actions");

    // The page's commands whose `enabled` holds.
    expect(actions).toEqual(
      expect.arrayContaining([
        "Previous step",
        "Approve step",
        "Toggle difference view",
        "Zoom in",
      ]),
    );
    // Not enabled here: no reject handler, no next step, no viewports.
    expect(actions).not.toContain("Reject step");
    expect(actions).not.toContain("Next step");
    expect(actions).not.toContain("Previous viewport");
    // Every page's commands are not this page's actions.
    for (const global of [
      "Open command palette",
      "Undo last review action",
      "Go to Batches",
      "Keyboard shortcuts",
      "Toggle theme",
    ]) {
      expect(actions).not.toContain(global);
    }

    // Keys, right-aligned, and named for assistive technology.
    const approve = within(group(palette, "Actions")).getByRole("option", {
      name: "Approve step",
    });
    expect(caps(approve)).toEqual(["A"]);
    expect(approve.getAttribute("aria-keyshortcuts")).toBe("A");
    const zoom = within(group(palette, "Actions")).getByRole("option", {
      name: "Zoom in",
    });
    expect(caps(zoom)).toEqual(["=", "+"]);
    const prev = within(group(palette, "Actions")).getByRole("option", {
      name: "Previous step",
    });
    expect(caps(prev)).toEqual(["←"]);

    // Running one closes the palette first, then runs it.
    fireEvent.click(approve);
    expect(usePaletteStore.getState().open).toBe(false);
    await settle();
    expect(onApprove).toHaveBeenCalledOnce();
    expect(openWhenRun).toEqual([false]);
  });

  test("keys show ⌘ on a Mac and Ctrl elsewhere", async () => {
    const COMMANDS: Command[] = [
      {
        id: "test.edit",
        label: "Edit the thing",
        group: "Editor",
        keys: ["$mod+e"],
        scope: "batches",
        run: vi.fn(),
      },
    ];
    function Page() {
      useCommands("batches", COMMANDS, {});
      return null;
    }
    const cases = [
      ["MacIntel", ["⌘", "E"], "Meta+E"],
      ["Win32", ["Ctrl", "E"], "Control+E"],
    ] as const;
    for (const [platform, shown, aria] of cases) {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      render(
        <Shell>
          <Page />
        </Shell>,
      );
      const option = within(await openPalette()).getByRole("option", {
        name: "Edit the thing",
      });
      expect(caps(option), platform).toEqual(shown);
      expect(option.getAttribute("aria-keyshortcuts"), platform).toBe(aria);
      cleanup();
      act(() => usePaletteStore.setState({ open: false }));
      useCommandRegistry.setState({ entries: [], role: "guest" });
    }
  });

  test("Undo last review action appears in Actions only when there is something to undo", async () => {
    const ENTRY = {
      actionId: "a1",
      label: "Approved home",
      runIds: ["r1"],
    };
    // Nothing to undo: not offered, with a page that has actions of its own
    // and with one that has none.
    const { unmount } = render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={vi.fn()} />
      </Shell>,
    );
    let palette = await openPalette();
    expect(labels(palette, "Actions")).not.toContain("Undo last review action");
    unmount();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });
    render(<Shell role="editor" />);
    palette = await openPalette();
    expect(headings(palette)).not.toContain("Actions");
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    // Something to undo: it is the last of the page's actions, with its key.
    act(() => useUndoStore.getState().push(ENTRY));
    render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={vi.fn()} />
      </Shell>,
    );
    palette = await openPalette();
    const actions = labels(palette, "Actions");
    expect(actions).toContain("Approve step");
    expect(actions.at(-1)).toBe("Undo last review action");
    const undo = within(group(palette, "Actions")).getByRole("option", {
      name: "Undo last review action",
    });
    expect(caps(undo)).toEqual(["Ctrl", "Z"]);
    expect(undo.getAttribute("aria-keyshortcuts")).toBe("Control+Z");

    // Choosing it takes back the newest action, once the palette has closed.
    fireEvent.click(undo);
    expect(usePaletteStore.getState().open).toBe(false);
    expect(undoMock).not.toHaveBeenCalled();
    await settle();
    expect(undoMock).toHaveBeenCalledTimes(1);
    expect(undoMock).toHaveBeenCalledWith();
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    // On a page with no actions of its own, it is the only action.
    render(<Shell role="editor" />);
    expect(labels(await openPalette(), "Actions")).toEqual([
      "Undo last review action",
    ]);
  });

  test("⌘K then Enter with something to undo and no page actions does not undo", async () => {
    act(() =>
      useUndoStore
        .getState()
        .push({ actionId: "a1", label: "Approved home", runIds: ["r1"] }),
    );
    /** The row Enter would choose. */
    const selected = (palette: HTMLElement) =>
      palette.querySelector('[role="option"][aria-selected="true"]')
        ?.firstElementChild?.textContent;
    const enter = () =>
      fireEvent.keyDown(screen.getByTestId("command-input"), { key: "Enter" });

    // On a page with no actions of its own, undo is the only one: it is not
    // what is chosen. Enter goes to Batches, the first row after it.
    render(<Shell role="editor" />);
    press("k", { ctrlKey: true });
    let palette = await screen.findByTestId("command-palette");
    expect(labels(palette, "Actions")).toEqual(["Undo last review action"]);
    expect(selected(palette)).toBe("Batches");
    enter();
    expect(pushMock).toHaveBeenCalledWith("/inbox");
    await settle();
    expect(undoMock).not.toHaveBeenCalled();
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    // With page actions, the first of them is chosen.
    render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={vi.fn()} />
      </Shell>,
    );
    press("k", { ctrlKey: true });
    palette = await screen.findByTestId("command-palette");
    const actions = labels(palette, "Actions");
    expect(actions.at(-1)).toBe("Undo last review action");
    expect(selected(palette)).toBe(actions[0]);
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    // Undo is still one arrow key away, and one search away.
    render(<Shell role="editor" />);
    press("k", { ctrlKey: true });
    palette = await screen.findByTestId("command-palette");
    fireEvent.keyDown(screen.getByTestId("command-input"), {
      key: "ArrowUp",
    });
    expect(selected(palette)).toBe("Undo last review action");
    enter();
    await settle();
    expect(undoMock).toHaveBeenCalledTimes(1);
    undoMock.mockReset();

    press("k", { ctrlKey: true });
    palette = await screen.findByTestId("command-palette");
    fireEvent.change(screen.getByTestId("command-input"), {
      target: { value: "undo last" },
    });
    expect(selected(palette)).toBe("Undo last review action");
    enter();
    await settle();
    expect(undoMock).toHaveBeenCalledTimes(1);
  });

  test("after typing and clearing, Enter does not undo", async () => {
    // cmdk selects its first row again whenever the search changes. Cleared,
    // that first row is Undo on a page with no actions of its own: the
    // palette's starting choice must come back instead.
    act(() =>
      useUndoStore
        .getState()
        .push({ actionId: "a1", label: "Approved home", runIds: ["r1"] }),
    );
    const selected = (palette: HTMLElement) =>
      palette.querySelector('[role="option"][aria-selected="true"]')
        ?.firstElementChild?.textContent;
    const input = () => screen.getByTestId("command-input");
    const type = (value: string) =>
      fireEvent.change(input(), { target: { value } });

    // No page actions: Undo is the only action and the first row.
    render(<Shell role="editor" />);
    let palette = await openPalette();
    expect(labels(palette, "Actions")).toEqual(["Undo last review action"]);
    expect(selected(palette)).toBe("Batches");

    // Typed to something that matches Undo and nothing before it...
    type("undo last");
    expect(selected(palette)).toBe("Undo last review action");
    // ...and cleared: the starting choice, not the first row.
    type("");
    expect(selected(palette)).toBe("Batches");
    // Cleared from a longer text and a one-letter text alike.
    type("settings");
    type("s");
    type("");
    expect(selected(palette)).toBe("Batches");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/inbox");
    await settle();
    expect(undoMock).not.toHaveBeenCalled();
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    // With page actions it is the first of them again, after a search that
    // chose something else.
    render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={vi.fn()} />
      </Shell>,
    );
    palette = await openPalette();
    const first = labels(palette, "Actions")[0];
    type("undo last");
    expect(selected(palette)).toBe("Undo last review action");
    type("");
    expect(selected(palette)).toBe(first);
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    // The arrow keys still move the choice from there, and Undo is one away.
    render(<Shell role="editor" />);
    palette = await openPalette();
    type("zz");
    type("");
    expect(selected(palette)).toBe("Batches");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selected(palette)).toBe("Undo last review action");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selected(palette)).toBe("Batches");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selected(palette)).not.toBe("Batches");
    expect(selected(palette)).not.toBe("Undo last review action");
  });

  test("a guest never sees it", async () => {
    // Even with an action on the stack: a guest cannot have made one in this
    // session, and cannot take one back.
    act(() =>
      useUndoStore
        .getState()
        .push({ actionId: "a1", label: "Approved home", runIds: ["r1"] }),
    );
    render(
      <Shell role="guest">
        <Viewer viewports={[]} onNextDiff={vi.fn()} />
      </Shell>,
    );
    const palette = await openPalette();
    expect(
      within(palette).queryByRole("option", {
        name: /Undo last review action/,
      }),
    ).toBeNull();
    // Their other actions are there: it is this one that is not.
    expect(labels(palette, "Actions")).toContain("Next change");
  });

  test("with single-key shortcuts off, an action shows no character key", async () => {
    render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={vi.fn()} onPrevStep={vi.fn()} />
      </Shell>,
    );
    act(() => useSingleKeyStore.setState({ on: false }));
    const palette = await openPalette();
    const actions = group(palette, "Actions");
    // `a` does nothing now: no key shown. ← still works.
    const approve = within(actions).getByRole("option", {
      name: "Approve step",
    });
    expect(caps(approve)).toEqual([]);
    expect(approve.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(
      caps(within(actions).getByRole("option", { name: "Previous step" })),
    ).toEqual(["←"]);
  });

  test("an action runs once the palette has closed, if it is still allowed and enabled then", async () => {
    // State that changes without a re-render, after the pick.
    const live = { allowed: true, enabled: true };
    const run = vi.fn();
    const COMMANDS: Command[] = [
      {
        id: "test.act",
        label: "Do the thing",
        group: "Review",
        scope: "viewer",
        allowed: () => live.allowed,
        enabled: () => live.enabled,
        run,
      },
    ];
    function Page() {
      useCommands("viewer", COMMANDS, {});
      return null;
    }
    render(
      <Shell role="editor">
        <Page />
      </Shell>,
    );
    const pick = async () => {
      const palette = await openPalette();
      fireEvent.click(
        within(group(palette, "Actions")).getByRole("option", {
          name: "Do the thing",
        }),
      );
      expect(usePaletteStore.getState().open).toBe(false);
    };

    // Not while the palette still holds focus: once it has let go.
    await pick();
    expect(run).not.toHaveBeenCalled();
    await settle();
    expect(run).toHaveBeenCalledOnce();
    // No key ran it (R22).
    expect(run).toHaveBeenCalledWith(expect.anything(), {});

    // Checked when it runs, not when it was picked.
    run.mockClear();
    await pick();
    live.enabled = false;
    await settle();
    expect(run).not.toHaveBeenCalled();

    live.enabled = true;
    await pick();
    live.allowed = false;
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  test("a page command that focuses an input keeps focus after the palette closes", async () => {
    const COMMANDS: Command[] = [
      {
        id: "test.search",
        label: "Search batches",
        group: "Navigate",
        scope: "batches",
        run: () => document.getElementById("batch-search")?.focus(),
      },
    ];
    function Page() {
      useCommands("batches", COMMANDS, {});
      return (
        <>
          <button type="button">Somewhere</button>
          <input id="batch-search" aria-label="Search batches" />
        </>
      );
    }
    render(
      <Shell>
        <Page />
      </Shell>,
    );
    // Opened from elsewhere on the page, where focus would go back to.
    act(() => screen.getByRole("button", { name: "Somewhere" }).focus());
    press("k", { ctrlKey: true });
    const palette = await screen.findByTestId("command-palette");
    fireEvent.click(
      within(group(palette, "Actions")).getByRole("option", {
        name: "Search batches",
      }),
    );
    await settle();
    const search = document.getElementById("batch-search");
    expect(document.activeElement).toBe(search);
    // And it stays there once the close is long done.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(search);
  });

  test("a command picked just before the palette opens again never runs late", async () => {
    const run = vi.fn();
    const COMMANDS: Command[] = [
      {
        id: "test.act",
        label: "Do the thing",
        group: "Review",
        scope: "viewer",
        run,
      },
    ];
    function Page() {
      useCommands("viewer", COMMANDS, {});
      return null;
    }
    render(
      <Shell>
        <Page />
      </Shell>,
    );
    const palette = await openPalette();
    fireEvent.click(
      within(group(palette, "Actions")).getByRole("option", {
        name: "Do the thing",
      }),
    );
    // Open again before that close has let go of focus.
    await openPalette();
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  test("closing the palette returns focus to where it was", async () => {
    render(
      <Shell>
        <button type="button">Somewhere</button>
      </Shell>,
    );
    const somewhere = screen.getByRole("button", { name: "Somewhere" });

    // Closed with Escape.
    act(() => somewhere.focus());
    press("k", { ctrlKey: true });
    await screen.findByTestId("command-palette");
    expect(document.activeElement).not.toBe(somewhere);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(usePaletteStore.getState().open).toBe(false);
    expect(document.activeElement).toBe(somewhere);

    // A command that moves no focus: it is back where it was too.
    press("k", { ctrlKey: true });
    const palette = await screen.findByTestId("command-palette");
    fireEvent.click(
      within(group(palette, "Preferences")).getByRole("option", {
        name: "Turn single-key shortcuts off",
      }),
    );
    await settle();
    expect(useSingleKeyStore.getState().on).toBe(false);
    expect(document.activeElement).toBe(somewhere);
  });

  test("a navigation pick does not refocus the opener", async () => {
    // Recent holds an admin page and the project jumps are the admin's: all
    // four kinds of page are there to pick.
    localStorage.setItem(
      RECENT_A,
      JSON.stringify([{ id: "admin.members", label: "Members" }]),
    );
    render(
      <Shell role="admin">
        <button type="button">Somewhere</button>
      </Shell>,
    );
    const somewhere = screen.getByRole("button", { name: "Somewhere" });
    const picks: [heading: string, label: string][] = [
      ["Go to", "Batches"],
      ["Recent", "Members"],
      ["Projects", "Jump to project: Beta"],
      ["Account", "API tokens"],
    ];
    for (const [heading, label] of picks) {
      act(() => somewhere.focus());
      press("k", { ctrlKey: true });
      const palette = await screen.findByTestId("command-palette");
      fireEvent.click(
        within(group(palette, heading)).getByRole("option", { name: label }),
      );
      await settle();
      // The page it went to may have focused something: the opener, which
      // is on a page that is going away, does not take it back.
      expect(usePaletteStore.getState().open, label).toBe(false);
      expect(document.activeElement, label).not.toBe(somewhere);
    }

    // Not picking, or picking a command, still gives focus back.
    act(() => somewhere.focus());
    press("k", { ctrlKey: true });
    await screen.findByTestId("command-palette");
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(document.activeElement).toBe(somewhere);
  });

  test("focus goes back to the opener without scrolling the page", async () => {
    render(
      <Shell>
        <button type="button">Somewhere</button>
      </Shell>,
    );
    const somewhere = screen.getByRole("button", { name: "Somewhere" });
    act(() => somewhere.focus());
    const focus = vi.spyOn(somewhere, "focus");
    press("k", { ctrlKey: true });
    await screen.findByTestId("command-palette");
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  describe("the search box names the chosen row (R30)", () => {
    const chosenLabel = (palette: HTMLElement) =>
      palette.querySelector('[role="option"][aria-selected="true"]')
        ?.firstElementChild?.textContent;

    test("right after the palette opens", async () => {
      // With something to undo and no page actions, undo is the first row and
      // is not the one chosen: Batches is.
      act(() =>
        useUndoStore
          .getState()
          .push({ actionId: "a1", label: "Approved home", runIds: ["r1"] }),
      );
      render(<Shell role="editor" />);
      const palette = await openPalette();
      await waitFor(() => expectNamesChosenRow(palette));
      expect(chosenLabel(palette)).toBe("Batches");
    });

    test("after a search is typed and cleared", async () => {
      act(() =>
        useUndoStore
          .getState()
          .push({ actionId: "a1", label: "Approved home", runIds: ["r1"] }),
      );
      render(<Shell role="editor" />);
      const palette = await openPalette();
      const input = screen.getByTestId("command-input");
      fireEvent.change(input, { target: { value: "settings" } });
      expect(chosenLabel(palette)).toBe("Settings");

      fireEvent.change(input, { target: { value: "" } });
      // The starting row again, and named: undo, which cmdk chooses first, is
      // not what the search box says.
      await waitFor(() => expect(chosenLabel(palette)).toBe("Batches"));
      await waitFor(() => expectNamesChosenRow(palette));
    });

    test("after the page's first action is the starting row", async () => {
      render(
        <Shell role="editor">
          <Viewer viewports={[]} onApprove={vi.fn()} />
        </Shell>,
      );
      const palette = await openPalette();
      await waitFor(() => expectNamesChosenRow(palette));
      expect(chosenLabel(palette)).toBe(labels(palette, "Actions")[0]);
    });

    test("after an arrow key", async () => {
      render(<Shell role="editor" />);
      const palette = await openPalette();
      fireEvent.keyDown(screen.getByTestId("command-input"), {
        key: "ArrowDown",
      });
      expect(chosenLabel(palette)).toBe("Settings");
      expectNamesChosenRow(palette);
    });

    test.each([
      ["commands only", "zoom", "Zoom in"],
      ["a page only", "settings", "Settings"],
      ["one command", "reject", "Reject step"],
    ])(
      "after a change that matches %s (cmdk's own first row)",
      async (_what, text, first) => {
        render(
          <Shell role="editor">
            <Viewer viewports={[]} onApprove={vi.fn()} onReject={vi.fn()} />
          </Shell>,
        );
        const palette = await openPalette();
        const input = screen.getByTestId("command-input");
        fireEvent.change(input, { target: { value: text } });
        expect(chosenLabel(palette)).toBe(first);
        await waitFor(() => expectNamesChosenRow(palette));
      },
    );

    test("through every step of typing and deleting", async () => {
      render(
        <Shell role="editor">
          <Viewer viewports={[]} onApprove={vi.fn()} onReject={vi.fn()} />
        </Shell>,
      );
      const palette = await openPalette();
      const input = screen.getByTestId("command-input");
      // Many rows, a few, one, then fewer again, none, and back to all.
      for (const text of [
        "z",
        "zo",
        "zoom",
        "zoom o",
        "zoo",
        "z",
        "",
        "re",
        "reject",
        "rejectx",
        "",
        "api",
      ]) {
        fireEvent.change(input, { target: { value: text } });
        await waitFor(() => expectNamesChosenRow(palette));
      }
    });

    test("the row is never seen unchosen while it is being named", async () => {
      // Looked at between every two turns, which is when a screen would be
      // painted: whenever there are rows, one of them is drawn as chosen.
      const unchosen: string[] = [];
      let step = "open";
      const look = setInterval(() => {
        const palette = document.querySelector(
          '[data-testid="command-palette"]',
        );
        if (!palette) return;
        const rows = palette.querySelectorAll('[role="option"]');
        const chosen = palette.querySelectorAll(
          '[role="option"][aria-selected="true"]',
        );
        if (rows.length > 0 && chosen.length !== 1) unchosen.push(step);
      }, 0);
      try {
        render(
          <Shell role="editor">
            <Viewer viewports={[]} onApprove={vi.fn()} onReject={vi.fn()} />
          </Shell>,
        );
        const palette = await openPalette();
        const input = screen.getByTestId("command-input");
        const wait = () =>
          act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
          });
        await wait();
        for (const text of ["zoom", "settings", "", "re", "api", ""]) {
          step = JSON.stringify(text);
          fireEvent.change(input, { target: { value: text } });
          await wait();
        }
        step = "pointer";
        fireEvent.pointerMove(
          within(palette).getAllByRole("option").at(-1) as HTMLElement,
        );
        await wait();
        expect(unchosen).toEqual([]);
        await waitFor(() => expectNamesChosenRow(palette));
      } finally {
        clearInterval(look);
      }
    });

    test("a search with no results names nothing, not the row it had", async () => {
      render(<Shell role="editor" />);
      const palette = await openPalette();
      const input = screen.getByTestId("command-input");
      fireEvent.change(input, { target: { value: "settings" } });
      await waitFor(() => expectNamesChosenRow(palette));
      expect(chosenLabel(palette)).toBe("Settings");

      fireEvent.change(input, { target: { value: "zzzz" } });
      expect(
        palette.querySelectorAll('[role="option"][aria-selected="true"]'),
      ).toHaveLength(0);
      await waitFor(() => expectNamesChosenRow(palette));
      expect(input.getAttribute("aria-activedescendant")).toBeNull();
      // And a row again once something matches.
      fireEvent.change(input, { target: { value: "settings" } });
      await waitFor(() => expectNamesChosenRow(palette));
      expect(chosenLabel(palette)).toBe("Settings");
    });

    test("after the pointer moves onto a row", async () => {
      render(<Shell role="editor" />);
      const palette = await openPalette();
      await waitFor(() => expectNamesChosenRow(palette));
      fireEvent.pointerMove(
        within(palette).getByRole("option", { name: "API tokens" }),
      );
      expect(chosenLabel(palette)).toBe("API tokens");
      await waitFor(() => expectNamesChosenRow(palette));
      // And onto another, after a search.
      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "t" },
      });
      await waitFor(() => expectNamesChosenRow(palette));
      const rows = within(palette).getAllByRole("option");
      fireEvent.pointerMove(rows[rows.length - 1] as HTMLElement);
      await waitFor(() => expectNamesChosenRow(palette));
    });

    test("a typed search keeps cmdk's own choice", async () => {
      // Undo and Batches both match "a"; cmdk chooses the first, undo, for
      // the typed text. The starting row is not put back over it.
      act(() =>
        useUndoStore
          .getState()
          .push({ actionId: "a1", label: "Approved home", runIds: ["r1"] }),
      );
      render(<Shell role="editor" />);
      const palette = await openPalette();
      await waitFor(() => expectNamesChosenRow(palette));
      fireEvent.change(screen.getByTestId("command-input"), {
        target: { value: "a" },
      });
      expect(chosenLabel(palette)).toBe("Undo last review action");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(chosenLabel(palette)).toBe("Undo last review action");
      expect(undoMock).not.toHaveBeenCalled();
    });

    test("naming the row does not choose another, run anything or reach the page", async () => {
      act(() =>
        useUndoStore
          .getState()
          .push({ actionId: "a1", label: "Approved home", runIds: ["r1"] }),
      );
      // What the page's listeners see while the palette names its row.
      const seen: string[] = [];
      const onEvent = (e: Event) => seen.push(e.type);
      const types = ["pointermove", "keydown"];
      for (const type of types) window.addEventListener(type, onEvent);
      try {
        render(<Shell role="editor" />);
        const palette = await openPalette();
        await waitFor(() => expectNamesChosenRow(palette));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
        });
        expect(chosenLabel(palette)).toBe("Batches");
        expect(undoMock).not.toHaveBeenCalled();
        expect(seen).toEqual([]);
      } finally {
        for (const type of types) window.removeEventListener(type, onEvent);
      }
    });
  });

  test("a key another scope takes is not shown on the command", async () => {
    // A page binding `?` itself: the global Keyboard shortcuts loses it.
    const COMMANDS: Command[] = [
      {
        id: "test.help",
        label: "Page help",
        group: "Help",
        keys: ["?"],
        scope: "batches",
        run: vi.fn(),
      },
    ];
    function Page() {
      useCommands("batches", COMMANDS, {});
      return null;
    }
    render(
      <Shell role="editor">
        <Page />
      </Shell>,
    );
    const palette = await openPalette();
    expect(
      caps(within(palette).getByRole("option", { name: "Page help" })),
    ).toEqual(["?"]);
    expect(
      caps(within(palette).getByRole("option", { name: "Keyboard shortcuts" })),
    ).toEqual([]);
  });

  test("a guest sees no decision actions", async () => {
    const handlers: ShortcutOptions = {
      viewports: [],
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onNextDiff: vi.fn(),
    };
    render(
      <Shell role="guest">
        <Viewer {...handlers} />
      </Shell>,
    );
    let actions = labels(await openPalette(), "Actions");
    // Navigation is anyone's; deciding is not.
    expect(actions).toContain("Next change");
    expect(actions).not.toContain("Approve step");
    expect(actions).not.toContain("Reject step");
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    // A reviewer sees them, with the same handlers.
    render(
      <Shell role="editor">
        <Viewer {...handlers} />
      </Shell>,
    );
    actions = labels(await openPalette(), "Actions");
    expect(actions).toEqual(
      expect.arrayContaining(["Approve step", "Reject step", "Next change"]),
    );
  });

  test("Jump to project is admin-only", async () => {
    render(<Shell role="editor" />);
    let palette = await openPalette();
    expect(headings(palette)).not.toContain("Projects");
    expect(within(palette).queryByText(/Jump to project/)).toBeNull();
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));

    // Owners pass every admin gate.
    for (const role of ["admin", "owner"] as const) {
      pushMock.mockReset();
      render(<Shell role={role} userId="" />);
      palette = await openPalette();
      expect(labels(palette, "Projects"), role).toEqual([
        "Jump to project: Acme",
        "Jump to project: Beta",
      ]);
      fireEvent.click(
        within(group(palette, "Projects")).getByRole("option", {
          name: "Jump to project: Beta",
        }),
      );
      expect(pushMock).toHaveBeenCalledWith("/projects/p2/builds");
      expect(usePaletteStore.getState().open).toBe(false);
      cleanup();
    }
  });

  test("labels are human (Members, not /admin/members)", async () => {
    const destinations: [heading: string, label: string, href: string][] = [
      ["Go to", "Batches", "/inbox"],
      ["Go to", "Analytics", "/analytics"],
      ["Go to", "Settings", "/projects/p1/settings"],
      ["Go to", "Members", "/admin/members"],
      ["Go to", "Projects", "/admin/projects"],
      ["Go to", "Installations", "/admin/installations"],
      ["Go to", "API keys", "/admin/api-keys"],
      ["Go to", "Auto rules", "/admin/auto-rules"],
      ["Go to", "Audit log", "/admin/audit-log"],
      ["Account", "API tokens", "/account/tokens"],
    ];
    render(<Shell role="admin" userId="" />);
    let palette = await openPalette();
    expect(labels(palette, "Go to")).toEqual(
      destinations.filter(([h]) => h === "Go to").map(([, label]) => label),
    );
    expect(labels(palette, "Account")).toEqual(["API tokens"]);
    // No option reads as a path, or is found by one.
    for (const option of within(palette).getAllByRole("option")) {
      expect(option.firstElementChild?.textContent).not.toMatch(/\//);
    }
    await userEvent.setup().type(screen.getByTestId("command-input"), "admin");
    expect(within(palette).queryAllByRole("option")).toHaveLength(0);
    act(() => usePaletteStore.setState({ open: false }));

    for (const [heading, label, href] of destinations) {
      pushMock.mockReset();
      palette = await openPalette();
      fireEvent.click(
        within(group(palette, heading)).getByRole("option", { name: label }),
      );
      expect(pushMock, label).toHaveBeenCalledWith(href);
      expect(usePaletteStore.getState().open).toBe(false);
    }
    cleanup();

    // An editor: Batches and their project's settings. Without a current
    // project, Batches alone.
    render(<Shell role="editor" userId="" />);
    expect(labels(await openPalette(), "Go to")).toEqual([
      "Batches",
      "Settings",
    ]);
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    render(<Shell role="editor" userId="" defaultProjectId={null} />);
    expect(labels(await openPalette(), "Go to")).toEqual(["Batches"]);
  });

  test("Preferences lists the enabled preference and help commands and runs one", async () => {
    render(<Shell role="editor" />);
    let palette = await openPalette();
    // The switch's applicable half only; no tour on this page.
    expect(labels(palette, "Preferences")).toEqual([
      "Toggle theme",
      "Turn single-key shortcuts off",
      "Keyboard shortcuts",
    ]);
    expect(
      caps(
        within(group(palette, "Preferences")).getByRole("option", {
          name: "Keyboard shortcuts",
        }),
      ),
    ).toEqual(["?"]);

    fireEvent.click(
      within(group(palette, "Preferences")).getByRole("option", {
        name: "Turn single-key shortcuts off",
      }),
    );
    expect(usePaletteStore.getState().open).toBe(false);
    await settle();
    expect(useSingleKeyStore.getState().on).toBe(false);

    palette = await openPalette();
    expect(labels(palette, "Preferences")).toEqual([
      "Toggle theme",
      "Turn single-key shortcuts on",
      "Keyboard shortcuts",
    ]);
    fireEvent.click(
      within(group(palette, "Preferences")).getByRole("option", {
        name: "Keyboard shortcuts",
      }),
    );
    expect(usePaletteStore.getState().open).toBe(false);
    await settle();
    expect(useShortcutsSheet.getState().open).toBe(true);
  });

  test("no fetch on open", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal("fetch", fetchSpy);
    render(<Shell role="admin" />);
    const palette = await openPalette();
    // The projects are already there: the layout's, through the provider.
    expect(labels(palette, "Projects")).toEqual([
      "Jump to project: Acme",
      "Jump to project: Beta",
    ]);
    // Give a lazy fetch its chance.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("Recent is per user (user A's recent is absent for user B)", async () => {
    const a = render(<Shell userId="user-a" />);
    let palette = await openPalette();
    expect(headings(palette)).not.toContain("Recent");
    fireEvent.click(
      within(group(palette, "Account")).getByRole("option", {
        name: "API tokens",
      }),
    );
    expect(pushMock).toHaveBeenCalledWith("/account/tokens");
    a.unmount();

    const b = render(<Shell userId="user-b" />);
    palette = await openPalette();
    expect(headings(palette)).not.toContain("Recent");
    expect(
      within(palette).queryAllByRole("option", { name: "API tokens" }),
    ).toHaveLength(1);
    b.unmount();
    act(() => usePaletteStore.setState({ open: false }));

    render(<Shell userId="user-a" />);
    palette = await openPalette();
    expect(labels(palette, "Recent")).toEqual(["API tokens"]);
    // Kept by the page's id, not by where it went.
    expect(JSON.parse(localStorage.getItem(RECENT_A) ?? "null")).toEqual([
      { id: "account.tokens", label: "API tokens" },
    ]);
    // A Recent entry goes where it went before.
    pushMock.mockReset();
    fireEvent.click(
      within(group(palette, "Recent")).getByRole("option", {
        name: "API tokens",
      }),
    );
    expect(pushMock).toHaveBeenCalledWith("/account/tokens");
  });

  test("Recent keeps the 5 newest, each once, newest first", async () => {
    render(<Shell role="admin" />);
    // Six pages, Installations twice.
    const picks = [
      "Members",
      "Projects",
      "Installations",
      "API keys",
      "Auto rules",
      "Installations",
      "Audit log",
    ];
    for (const label of picks) {
      const palette = await openPalette();
      fireEvent.click(
        within(group(palette, "Go to")).getByRole("option", { name: label }),
      );
    }
    expect(labels(await openPalette(), "Recent")).toEqual([
      "Audit log",
      "Installations",
      "Auto rules",
      "API keys",
      "Projects",
    ]);
  });

  test("without a user id, or with storage blocked, Recent is not kept and the palette still works", async () => {
    // Not even a list stored under an empty id is read, or written.
    const underNoId = JSON.stringify([
      { id: "account.tokens", label: "API tokens" },
    ]);
    localStorage.setItem("furan:palette:recent:", underNoId);
    render(<Shell userId="" />);
    let palette = await openPalette();
    expect(headings(palette)).not.toContain("Recent");
    fireEvent.click(
      within(group(palette, "Go to")).getByRole("option", { name: "Batches" }),
    );
    expect(pushMock).toHaveBeenCalledWith("/inbox");
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("furan:palette:recent:")).toBe(underNoId);
    palette = await openPalette();
    expect(headings(palette)).not.toContain("Recent");
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));

    // Blocked storage (privacy modes): the default, nothing.
    localStorage.setItem(
      RECENT_A,
      JSON.stringify([{ id: "account.tokens", label: "API tokens" }]),
    );
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    pushMock.mockReset();
    render(<Shell userId="user-a" />);
    palette = await openPalette();
    expect(headings(palette)).not.toContain("Recent");
    fireEvent.click(
      within(group(palette, "Go to")).getByRole("option", { name: "Batches" }),
    );
    expect(pushMock).toHaveBeenCalledWith("/inbox");
  });

  test("a non-admin's Recent leaves out the admin pages and project jumps", async () => {
    // Kept from when this user was an admin: pages by id, and one kept by
    // its address (a page that is not one of the palette's own).
    const stored = [
      { id: "admin.members", label: "Members" },
      { id: "go.analytics", label: "Analytics" },
      { id: "project:p2", label: "Jump to project: Beta" },
      { id: "elsewhere", label: "An audit entry", href: "/admin/audit-log/7" },
      { id: "account.tokens", label: "API tokens" },
    ];
    localStorage.setItem(RECENT_A, JSON.stringify(stored));
    render(<Shell role="editor" />);
    expect(labels(await openPalette(), "Recent")).toEqual(["API tokens"]);
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));

    render(<Shell role="admin" />);
    expect(labels(await openPalette(), "Recent")).toEqual(
      stored.map((e) => e.label),
    );
  });

  test("a Recent page is kept by its id and goes where that page is now", async () => {
    localStorage.setItem(
      RECENT_A,
      JSON.stringify([
        { id: "go.settings", label: "Settings" },
        { id: "project:p1", label: "Jump to project: Old name" },
        { id: "project:p9", label: "Jump to project: Gone" },
        { id: "go.nowhere", label: "Nowhere" },
      ]),
    );
    // The current project is now Beta.
    render(<Shell role="admin" defaultProjectId="p2" />);
    const palette = await openPalette();
    // The project's name as it is now; a project no longer listed and a page
    // the palette doesn't know are left out.
    expect(labels(palette, "Recent")).toEqual([
      "Settings",
      "Jump to project: Acme",
    ]);
    fireEvent.click(
      within(group(palette, "Recent")).getByRole("option", {
        name: "Settings",
      }),
    );
    expect(pushMock).toHaveBeenCalledWith("/projects/p2/settings");
    expect(JSON.parse(localStorage.getItem(RECENT_A) ?? "null")[0]).toEqual({
      id: "go.settings",
      label: "Settings",
    });
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));

    // No current project: no Settings to go back to.
    render(<Shell role="admin" defaultProjectId={null} />);
    expect(labels(await openPalette(), "Recent")).toEqual([
      "Jump to project: Acme",
    ]);
  });

  test("the old un-keyed recent list is removed from this browser", async () => {
    localStorage.setItem(
      "furan:recent-projects",
      JSON.stringify([{ id: "p9", name: "Old" }]),
    );
    render(<Shell />);
    expect(localStorage.getItem("furan:recent-projects")).toBeNull();
    expect(headings(await openPalette())).not.toContain("Recent");
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));

    // Blocked storage: nothing breaks.
    localStorage.setItem("furan:recent-projects", "[]");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Shell />);
    expect(labels(await openPalette(), "Account")).toEqual(["API tokens"]);
  });

  test("a stored entry that is not a page of this app is not listed", async () => {
    localStorage.setItem(
      RECENT_A,
      JSON.stringify([
        { id: "a", label: "Evil", href: "javascript:alert(1)" },
        { id: "b", label: "Away", href: "//elsewhere.test/x" },
        { label: "No id", href: "/inbox" },
        { id: "c" },
        { id: "admin.members", label: "Members" },
      ]),
    );
    render(<Shell role="admin" />);
    expect(labels(await openPalette(), "Recent")).toEqual(["Members"]);
  });

  test("live region announces the result count", async () => {
    render(<Shell role="editor" userId="" />);
    const palette = await openPalette();
    const status = within(palette).getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    // Quiet on open, also once the delay has passed: nothing was typed.
    expect(status.textContent).toBe("");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(status.textContent).toBe("");

    const input = screen.getByTestId("command-input");
    const user = userEvent.setup();
    await user.type(input, "api");
    // Not on every keystroke: once typing settles.
    expect(status.textContent).toBe("");
    await waitFor(() => expect(status.textContent).toBe("1 result"));
    expect(within(palette).getAllByRole("option")).toHaveLength(1);

    await user.clear(input);
    await user.type(input, "t");
    // The last search's count is not this one's.
    expect(status.textContent).toBe("");
    const shown = within(palette).getAllByRole("option").length;
    expect(shown).toBeGreaterThan(1);
    await waitFor(() => expect(status.textContent).toBe(`${shown} results`));

    await user.type(input, "zzzz");
    await waitFor(() => expect(status.textContent).toBe("No results"));
    expect(palette.querySelector("[cmdk-empty]")?.textContent).toBe(
      "No results",
    );
  });

  test("typing a in the input filters, approves nothing", async () => {
    // Review Focus 3, end to end: the layout's dispatcher, the viewer's
    // decision keys, the palette opened by its key.
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={onApprove} onReject={onReject} />
      </Shell>,
    );
    press("k", { ctrlKey: true });
    const palette = await screen.findByTestId("command-palette");
    const input = screen.getByTestId("command-input") as HTMLInputElement;
    act(() => input.focus());
    const before = within(palette).getAllByRole("option").length;
    expect(
      within(palette).getByRole("option", { name: "Toggle comments" }),
    ).toBeTruthy();

    const user = userEvent.setup();
    await user.type(input, "a");
    expect(onApprove).not.toHaveBeenCalled();
    // The letter is the search's, and it filters.
    expect(input.value).toBe("a");
    expect(within(palette).getAllByRole("option").length).toBeLessThan(before);
    expect(
      within(palette).queryByRole("option", { name: "Toggle comments" }),
    ).toBeNull();
    expect(
      within(palette).getByRole("option", { name: "Approve step" }),
    ).toBeTruthy();

    await user.type(input, "r");
    expect(onReject).not.toHaveBeenCalled();
    expect(input.value).toBe("ar");
    expect(usePaletteStore.getState().open).toBe(true);
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    // An admin, whose `?`, `/` and `g a` all do something on the page: typed
    // here, they are the search's too.
    render(
      <Shell role="admin">
        <Viewer viewports={[]} onApprove={onApprove} onReject={onReject} />
      </Shell>,
    );
    press("k", { ctrlKey: true });
    const adminInput = (await screen.findByTestId(
      "command-input",
    )) as HTMLInputElement;
    act(() => adminInput.focus());
    await user.type(adminInput, "?");
    expect(useShortcutsSheet.getState().open).toBe(false);
    await user.type(adminInput, "/");
    await user.type(adminInput, "g");
    await user.type(adminInput, "a");
    expect(adminInput.value).toBe("?/ga");
    expect(pushMock).not.toHaveBeenCalled();
    expect(onApprove).not.toHaveBeenCalled();
    expect(useShortcutsSheet.getState().open).toBe(false);
    expect(usePaletteStore.getState().open).toBe(true);
    expect(document.activeElement).toBe(adminInput);
  });
});
