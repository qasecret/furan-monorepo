/**
 * Island-level tests for the global cmdk command palette.
 *
 * Spec D5.5-D5.8 acceptance:
 *  1. $mod+K (⌘K on a Mac, Ctrl+K elsewhere) toggles the palette, through
 *     the one key dispatcher (the global `palette.open` command).
 *  2. Escape closes the palette.
 *  3. The command list reflects the user's projects; admin-only commands
 *     render only when userRole === "admin".
 *  4. Selecting a project command calls router.push for the builds page.
 *
 * The palette uses Radix Dialog under the hood; the shared tests/setup.ts
 * shims (ResizeObserver, scrollIntoView, pointer-capture) keep jsdom happy.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The global commands' ⌘Z: no review session here.
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: vi.fn() }),
}));

const fetchMock = vi.fn();

import { CommandPalette } from "../src/components/cmdk/command-palette";
import { usePaletteStore } from "../src/components/cmdk/use-command-palette";

import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import {
  CommandRoleProvider,
  useCommandRegistry,
} from "@/lib/commands/registry";

beforeEach(() => {
  pushMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [
      { id: "p1", name: "Acme" },
      { id: "p2", name: "Beta" },
    ],
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch;
  usePaletteStore.setState({ open: false });
  useCommandRegistry.setState({ entries: [], role: "guest" });
});

afterEach(() => {
  cleanup();
  usePaletteStore.setState({ open: false });
});

function press(key: string, modifiers: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...modifiers }),
  );
}

describe("CommandPalette", () => {
  test("$mod+K opens it and, from its search box, closes it", async () => {
    // The palette has no key listener of its own: the layout's dispatcher
    // runs `palette.open`.
    render(
      <CommandRoleProvider role="editor">
        <GlobalCommands />
        <CommandDispatcher />
        <CommandPalette userRole="editor" />
      </CommandRoleProvider>,
    );
    expect(usePaletteStore.getState().open).toBe(false);

    // jsdom is not a Mac: $mod is Ctrl.
    act(() => press("k", { ctrlKey: true }));
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
    render(<CommandPalette userRole="editor" />);
    // One press at a time: two would toggle it back.
    act(() => press("k", { ctrlKey: true }));
    expect(usePaletteStore.getState().open).toBe(false);
    act(() => press("k", { metaKey: true }));
    expect(usePaletteStore.getState().open).toBe(false);
  });

  test("closes on Escape", async () => {
    render(<CommandPalette userRole="editor" />);
    act(() => usePaletteStore.setState({ open: true }));
    await screen.findByTestId("command-palette");

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

  test("admin-only commands render only when userRole is admin", async () => {
    render(<CommandPalette userRole="editor" />);
    act(() => usePaletteStore.setState({ open: true }));
    await screen.findByTestId("command-palette");
    expect(screen.queryByTestId("cmd-admin-members")).toBeNull();
    // API Keys command is visible to all roles.
    expect(screen.queryByTestId("cmd-api-keys")).not.toBeNull();

    cleanup();
    usePaletteStore.setState({ open: false });

    render(<CommandPalette userRole="admin" />);
    act(() => usePaletteStore.setState({ open: true }));
    await screen.findByTestId("command-palette");
    expect(screen.getByTestId("cmd-admin")).toBeDefined();
    expect(screen.getByTestId("cmd-admin-members")).toBeDefined();
    expect(screen.getByTestId("cmd-admin-installations")).toBeDefined();
  });

  test("selecting a project command calls router.push to that project's builds", async () => {
    render(<CommandPalette userRole="editor" />);
    act(() => usePaletteStore.setState({ open: true }));
    await screen.findByTestId("command-palette");

    // Wait for the projects fetch to populate the list.
    await waitFor(() => {
      expect(screen.queryByTestId("cmd-project-p1")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("cmd-project-p1"));
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/projects/p1/builds");
    });
  });
});
