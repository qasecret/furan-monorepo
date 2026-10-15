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

// AccountMenu (now rendered inside TopBar) imports the logout server action,
// which reaches for next/headers; stub it so the component tree mounts in
// jsdom. Everything else (palette / mobile stores) stays real so these remain
// genuine wiring tests.
vi.mock("@/app/(protected)/_components/logout-action", () => ({
  logoutAction: vi.fn(),
}));

// ProjectSelector calls useCurrentProject() which throws outside a provider.
// Stub the whole module so TopBar tests don't need a real provider tree.
vi.mock("@/app/(protected)/_components/project-selector", () => ({
  ProjectSelector: () => (
    <div data-testid="project-selector-stub" aria-hidden="true" />
  ),
}));

// AccountMenu (rendered inside TopBar) now calls useCurrentProject(); stub the
// provider so the menu mounts without a real provider tree.
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: null,
    currentProject: null,
    projects: [],
  }),
}));

import { TopBar } from "@/app/(protected)/_components/top-bar";
import { useSidebarStore } from "@/app/(protected)/_components/use-sidebar-store";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { ShortcutsSheet } from "@/components/shortcuts/shortcuts-sheet";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { PageTour } from "@/components/tour/page-tour";
import {
  TourProvider,
  __resetTourDismissalsForTests,
  useTour,
  type TourStep,
} from "@/components/tour/tour-context";
import {
  SINGLE_KEYS_STORAGE_KEY,
  useSingleKeyStore,
} from "@/lib/commands/prefs";
import { useCommandRegistry } from "@/lib/commands/registry";
import { useReviewAnnouncer } from "@/lib/review/review-announcer";

const props = { email: "me@x.io", initial: "M", role: "admin" } as const;

const STEPS: TourStep[] = [{ target: "body", content: "Hello" }];

beforeEach(() => {
  useSidebarStore.setState({ collapsed: false, open: false });
  usePaletteStore.setState({ open: false });
  useShortcutsSheet.setState({ open: false, returnTo: null });
  useSingleKeyStore.setState({ on: true });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useReviewAnnouncer.setState({ text: "", seq: 0 });
  localStorage.clear();
  __resetTourDismissalsForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSidebarStore.setState({ collapsed: false, open: false });
  usePaletteStore.setState({ open: false });
  useShortcutsSheet.setState({ open: false, returnTo: null });
});

/** The top bar as the protected layout holds it: the sheet, a tour provider. */
function Chrome({ children }: { children?: ReactNode }) {
  return (
    <TourProvider>
      <TopBar {...props} />
      <ShortcutsSheet />
      {children}
    </TourProvider>
  );
}

/** Opens the Help menu and returns it. */
async function openHelp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Help" }));
  return screen.findByRole("menu");
}

/** Reads the tour from inside the provider, as the Help menu does. */
let tour: ReturnType<typeof useTour> | undefined;
function TourSpy() {
  tour = useTour();
  return null;
}

describe("TopBar", () => {
  // The desktop collapse/expand toggle is wired to the sidebar store.
  test("clicking the collapse toggle flips the sidebar collapsed state", () => {
    render(<TopBar {...props} />);
    expect(useSidebarStore.getState().collapsed).toBe(false);

    fireEvent.click(screen.getByTestId("sidebar-collapse-toggle"));
    expect(useSidebarStore.getState().collapsed).toBe(true);
  });

  test("notification bell is disabled stub", () => {
    render(<TopBar {...props} />);
    const bell = screen.getByTestId("top-bar-bell") as HTMLButtonElement;
    expect(bell.disabled).toBe(true);
    expect(bell.getAttribute("aria-disabled")).toBe("true");
  });

  test("renders the account menu trigger with the user's initial", () => {
    render(<TopBar {...props} />);
    expect(
      screen.getByRole("button", { name: /account menu/i }).textContent,
    ).toContain("M");
  });

  test("palette button opens the palette and names ⌘K", async () => {
    // Not a Mac: Ctrl K.
    const view = render(<TopBar {...props} />);
    const button = screen.getByRole("button", { name: "Open command palette" });
    expect(within(button).getByText("Search or run a command…")).toBeTruthy();
    expect(within(button).getByText("Ctrl K").tagName).toBe("KBD");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+K");

    expect(usePaletteStore.getState().open).toBe(false);
    fireEvent.click(button);
    expect(usePaletteStore.getState().open).toBe(true);
    view.unmount();

    // A Mac: ⌘K.
    usePaletteStore.setState({ open: false });
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<TopBar {...props} />);
    const mac = screen.getByRole("button", { name: "Open command palette" });
    expect(within(mac).getByText("⌘K").tagName).toBe("KBD");
    expect(mac.getAttribute("aria-keyshortcuts")).toBe("Meta+K");
    fireEvent.click(mac);
    expect(usePaletteStore.getState().open).toBe(true);
  });

  test("palette button is before the theme toggle and the Help menu, and on a narrow screen keeps its icon and key", () => {
    render(<TopBar {...props} />);
    const button = screen.getByRole("button", { name: "Open command palette" });
    const help = screen.getByRole("button", { name: "Help" });
    const theme = screen.getByTestId("theme-toggle");
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(button, help)).toBe(true);
    expect(follows(help, theme)).toBe(true);

    // The words go below the md breakpoint; the icon and the key stay.
    const label = within(button).getByText("Search or run a command…");
    expect(label.className).toContain("hidden");
    expect(label.className).toContain("md:inline");
    expect(button.querySelector("svg")).toBeTruthy();
    const key = within(button).getByText("Ctrl K");
    expect(key.className).not.toMatch(/\bhidden\b/);
  });

  test("Help menu opens the sheet", async () => {
    const user = userEvent.setup();
    render(<Chrome />);
    const menu = await openHelp(user);
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Keyboard shortcuts"]);

    await user.click(
      within(menu).getByRole("menuitem", { name: "Keyboard shortcuts" }),
    );
    expect(useShortcutsSheet.getState().open).toBe(true);
    expect(
      await screen.findByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeTruthy();
    // The menu has closed behind it.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("closing the sheet opened from the Help menu returns focus to the Help button", async () => {
    const user = userEvent.setup();
    render(<Chrome />);
    const help = screen.getByRole("button", { name: "Help" });
    const menu = await openHelp(user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Keyboard shortcuts" }),
    );
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(help));
  });

  test("Replay tour appears only with a page tour", async () => {
    const user = userEvent.setup();

    // No provider (an isolated bar), and a provider but no page tour.
    const bare = render(<TopBar {...props} />);
    let menu = await openHelp(user);
    expect(within(menu).queryByRole("menuitem", { name: "Replay tour" })).toBe(
      null,
    );
    bare.unmount();
    cleanup();
    const noTour = render(<Chrome />);
    menu = await openHelp(user);
    expect(within(menu).queryByRole("menuitem", { name: "Replay tour" })).toBe(
      null,
    );
    await user.keyboard("{Escape}");
    noTour.unmount();

    // A page with a tour: dismissed before, so it registers without starting.
    localStorage.setItem("furan:tour:dismissed:inbox", "1");
    const withTour = (page: boolean) => (
      <Chrome>
        <TourSpy />
        {page && <PageTour pageId="inbox" steps={STEPS} />}
      </Chrome>
    );
    const view = render(withTour(true));
    menu = await openHelp(user);
    const replay = within(menu).getByRole("menuitem", { name: "Replay tour" });
    expect(tour?.state.active).toBe(false);

    // It replays that page's tour.
    await user.click(replay);
    expect(tour?.state.active).toBe(true);
    expect(tour?.state.pageId).toBe("inbox");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // And it is that page's: once the page is left it is gone from the menu.
    view.rerender(withTour(false));
    menu = await openHelp(user);
    expect(within(menu).queryByRole("menuitem", { name: "Replay tour" })).toBe(
      null,
    );
  });

  test("the single-key checkbox reflects and sets the switch", async () => {
    const user = userEvent.setup();
    render(<Chrome />);
    const checkbox = (menu: HTMLElement) =>
      within(menu).getByRole("menuitemcheckbox", {
        name: "Single-key shortcuts",
      });

    // Reflects: on.
    let menu = await openHelp(user);
    expect(checkbox(menu).getAttribute("aria-checked")).toBe("true");

    // Sets: off, stored, and said.
    await user.click(checkbox(menu));
    expect(useSingleKeyStore.getState().on).toBe(false);
    expect(localStorage.getItem(SINGLE_KEYS_STORAGE_KEY)).toBe("0");
    expect(useReviewAnnouncer.getState().text).toBe("Single-key shortcuts off");

    // Reflects: off, when the menu is opened again.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    menu = await openHelp(user);
    expect(checkbox(menu).getAttribute("aria-checked")).toBe("false");

    // Sets: on again.
    await user.click(checkbox(menu));
    expect(useSingleKeyStore.getState().on).toBe(true);
    expect(localStorage.getItem(SINGLE_KEYS_STORAGE_KEY)).toBe("1");
    expect(useReviewAnnouncer.getState().text).toBe("Single-key shortcuts on");

    // Follows a change made elsewhere (the sheet, the palette) while it shows.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    menu = await openHelp(user);
    act(() => useSingleKeyStore.setState({ on: false }));
    expect(checkbox(menu).getAttribute("aria-checked")).toBe("false");
  });
});
