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
import { KeyCaps } from "@/components/shortcuts/key-caps";
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
    const button = screen.getByRole("button", {
      name: "Search or run a command…",
    });
    const key = within(button).getByText("Ctrl K");
    expect(key.tagName).toBe("KBD");
    // The key is announced by `aria-keyshortcuts`, not read out twice.
    expect(key.getAttribute("aria-hidden")).toBe("true");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+K");

    expect(usePaletteStore.getState().open).toBe(false);
    fireEvent.click(button);
    expect(usePaletteStore.getState().open).toBe(true);
    view.unmount();

    // A Mac: ⌘K.
    usePaletteStore.setState({ open: false });
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<TopBar {...props} />);
    const mac = screen.getByRole("button", {
      name: "Search or run a command…",
    });
    expect(within(mac).getByText("⌘K").tagName).toBe("KBD");
    expect(mac.getAttribute("aria-keyshortcuts")).toBe("Meta+K");
    fireEvent.click(mac);
    expect(usePaletteStore.getState().open).toBe(true);
  });

  test("the palette button's accessible name contains its visible text at every width", () => {
    // WCAG 2.5.3 (Label in Name): what a person can read on the button is
    // what it is called, so speech input by that text finds it. There is no
    // `aria-label` to differ from it, and below `md` the words are visually
    // hidden but still the name, never `display: none`.
    render(<TopBar {...props} />);
    const button = screen.getByRole("button", {
      name: "Search or run a command…",
    });
    expect(button.hasAttribute("aria-label")).toBe(false);
    expect(button.hasAttribute("aria-labelledby")).toBe(false);

    const label = within(button).getByText("Search or run a command…");
    const removedAtAnyWidth = [...label.classList].filter((c) =>
      /(^|:)(hidden|invisible)$/.test(c),
    );
    expect(removedAtAnyWidth).toEqual([]);
    expect(label.classList.contains("max-md:sr-only")).toBe(true);
    // Below `md` the words go, so the badge is no part of the name either.
    expect(within(button).getByText("Ctrl K").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  test("palette button is before the theme toggle and the Help menu", () => {
    render(<TopBar {...props} />);
    const button = screen.getByRole("button", {
      name: "Search or run a command…",
    });
    const help = screen.getByRole("button", { name: "Help" });
    const theme = screen.getByTestId("theme-toggle");
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(button, help)).toBe(true);
    expect(follows(help, theme)).toBe(true);
  });

  test("the palette button's key badge is drawn as the sheet's key caps are", () => {
    // One definition of a key cap (`KeyBadge`), not a copy in the button.
    const { container } = render(
      <>
        <TopBar {...props} />
        <KeyCaps tokens={["K"]} />
      </>,
    );
    // The inner `kbd` of `KeyCaps` is a cap; the button's badge is a single one.
    const cap = container.querySelector("kbd kbd");
    const badge = within(
      screen.getByRole("button", { name: "Search or run a command…" }),
    ).getByText("Ctrl K");
    expect(cap).toBeTruthy();
    const shape = [...(cap?.classList ?? [])].filter(
      (c) => !c.startsWith("text-fg"),
    );
    expect(shape.length).toBeGreaterThan(4);
    expect([...badge.classList]).toEqual(expect.arrayContaining(shape));
  });

  test("the palette button gives up width as the screen narrows", () => {
    // The right cluster shares the bar with the project label and the
    // sidebar toggle: narrow at md, wide at lg, the key gone below sm, and
    // the words below md (the icon is always there).
    render(<TopBar {...props} />);
    const button = screen.getByRole("button", {
      name: "Search or run a command…",
    });
    expect(button.classList.contains("md:w-40")).toBe(true);
    expect(button.classList.contains("lg:w-64")).toBe(true);
    expect(button.classList.contains("md:w-64")).toBe(false);
    expect(button.querySelector("svg")).toBeTruthy();
    const label = within(button).getByText("Search or run a command…");
    expect(label.classList.contains("max-md:sr-only")).toBe(true);
    // The label shrinks and ellipsizes in the width it is given.
    expect(label.classList.contains("truncate")).toBe(true);
    expect(label.classList.contains("min-w-0")).toBe(true);
    expect(
      within(button).getByText("Ctrl K").classList.contains("max-sm:hidden"),
    ).toBe(true);
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

  test("the Help button does not take focus while the sheet it opened takes it", async () => {
    // The menu gives focus back to its button as it closes; for an item that
    // opens the sheet, that would be a hand-over to the wrong element for a
    // moment. The sheet takes focus, and gives it back to the button on close.
    const user = userEvent.setup();
    render(<Chrome />);
    const help = screen.getByRole("button", { name: "Help" });
    const focus = vi.spyOn(help, "focus");
    const menu = await openHelp(user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Keyboard shortcuts" }),
    );
    const sheet = await screen.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    // Past the tick in which the menu hands focus back.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(sheet);

    // Closing the sheet is what gives it back.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(help));
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test("closing the Help menu any other way still returns focus to its button", async () => {
    const user = userEvent.setup();
    render(<Chrome />);
    const help = screen.getByRole("button", { name: "Help" });

    // Esc, with nothing chosen.
    await openHelp(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(help));

    // After it has opened the sheet once: that was for one opening only.
    let menu = await openHelp(user);
    await user.click(
      within(menu).getByRole("menuitem", { name: "Keyboard shortcuts" }),
    );
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => document.body.focus());
    menu = await openHelp(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
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
