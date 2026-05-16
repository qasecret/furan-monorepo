/**
 * Island-level tests for the global cmdk command palette.
 *
 * Spec D5.5-D5.8 acceptance:
 *  1. Cmd+K / Ctrl+K toggles the palette open.
 *  2. Escape closes the palette.
 *  3. The command list reflects the user's projects; admin-only commands
 *     render only when userRole === "admin".
 *  4. Selecting a project command calls router.push for the runs page.
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

const fetchMock = vi.fn();

import { CommandPalette } from "../src/components/cmdk/command-palette";
import { usePaletteStore } from "../src/components/cmdk/use-command-palette";

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
  test("opens on Cmd+K and again on Ctrl+K", () => {
    render(<CommandPalette userRole="editor" />);
    expect(usePaletteStore.getState().open).toBe(false);

    act(() => press("k", { metaKey: true }));
    expect(usePaletteStore.getState().open).toBe(true);

    // Toggle off via the second binding.
    act(() => press("k", { ctrlKey: true }));
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
    // Account command is visible to all roles.
    expect(screen.queryByTestId("cmd-account-tokens")).not.toBeNull();

    cleanup();
    usePaletteStore.setState({ open: false });

    render(<CommandPalette userRole="admin" />);
    act(() => usePaletteStore.setState({ open: true }));
    await screen.findByTestId("command-palette");
    expect(screen.getByTestId("cmd-admin-members")).toBeDefined();
  });

  test("selecting a project command calls router.push to that project's runs", async () => {
    render(<CommandPalette userRole="editor" />);
    act(() => usePaletteStore.setState({ open: true }));
    await screen.findByTestId("command-palette");

    // Wait for the projects fetch to populate the list.
    await waitFor(() => {
      expect(screen.queryByTestId("cmd-project-p1")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("cmd-project-p1"));
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/projects/p1/runs");
    });
  });
});
