import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: vi.fn() }),
}));

import { ShortcutsSheet } from "@/components/shortcuts/shortcuts-sheet";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import {
  TourProvider,
  useTour,
  useTourSteps,
  __resetTourDismissalsForTests,
  type TourStep,
} from "@/components/tour/tour-context";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { formatKeys } from "@/lib/commands/keys";
import {
  SINGLE_KEYS_STORAGE_KEY,
  useSingleKeyStore,
} from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  findBinding,
  resolveCommands,
  resolveKeyMap,
  useCommandRegistry,
  useCommands,
} from "@/lib/commands/registry";
import type { Command, CommandScope, KeyBinding } from "@/lib/commands/types";
import { useReviewAnnouncer } from "@/lib/review/review-announcer";
import { canReviewRole, type ViewerRole } from "@/lib/roles";

const NOTE = "(single-key shortcuts are off)";
const HELP =
  "Turn off to stop letter and symbol keys from triggering actions. ⌘K, ⌘Z, arrows, Enter and Esc keep working.";

function command(
  scope: CommandScope,
  id: string,
  label: string,
  keys: KeyBinding[],
  extra: Partial<Command> = {},
): Command {
  return { id, label, group: "Review", keys, scope, run: vi.fn(), ...extra };
}

/** Registers `commands` in `scope`, as a page component would. */
function Page({
  scope,
  commands,
}: {
  scope: CommandScope;
  commands: Command[];
}) {
  useCommands(scope, commands, {});
  return null;
}

/** The protected layout's keyboard part plus the sheet, with a page. */
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
      {children}
      <ShortcutsSheet />
    </CommandRoleProvider>
  );
}

/** The viewer's scope, cut down to a few commands of every kind. */
const VIEWER: Command[] = [
  command("viewer", "review.approve", "Approve step", ["a"], {
    allowed: ({ role }) => canReviewRole(role),
  }),
  command("viewer", "viewer.nextStep", "Next step", ["ArrowRight"]),
  command("viewer", "viewer.fit", "Fit", ["0"]),
];

function openSheet() {
  act(() => useShortcutsSheet.getState().setOpen(true));
}

function sheet(): HTMLElement {
  return screen.getByRole("dialog", { name: "Keyboard shortcuts" });
}

/** A section's heading text and the rows under it, as a reader sees them. */
function sections(): { heading: string; rows: HTMLElement[] }[] {
  return within(sheet())
    .getAllByRole("region")
    .map((region) => {
      const heading = document.getElementById(
        region.getAttribute("aria-labelledby") ?? "",
      );
      return {
        heading: heading?.textContent ?? "",
        rows: within(region).queryAllByRole("listitem"),
      };
    });
}

function rowOf(label: string): HTMLElement {
  const row = within(sheet())
    .getAllByRole("listitem")
    .find((li) => li.firstElementChild?.textContent === label);
  if (!row) throw new Error(`No row labelled "${label}"`);
  return row;
}

/** The keys of a row: one entry per key, its tokens as rendered. */
function keysOf(row: HTMLElement): string[][] {
  return Array.from(row.querySelectorAll("kbd"))
    .filter((k) => k.parentElement?.closest("kbd") == null)
    .map((outer) =>
      Array.from(outer.children).map((child) => child.textContent ?? ""),
    );
}

/** Every key the sheet shows, with the label of its row. */
function shownKeys(): { label: string; tokens: string[] }[] {
  return within(sheet())
    .getAllByRole("listitem")
    .flatMap((row) =>
      keysOf(row).map((tokens) => ({
        label: row.firstElementChild?.textContent ?? "",
        tokens,
      })),
    );
}

function tokensOf(key: KeyBinding): string[] {
  return formatKeys([key], "other")[0] ?? [];
}

beforeEach(() => {
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  useShortcutsSheet.setState({ open: false });
  useReviewAnnouncer.setState({ text: "", seq: 0 });
  pushMock.mockReset();
  localStorage.clear();
  __resetTourDismissalsForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("ShortcutsSheet", () => {
  it("is closed until the store opens it, and Escape closes it", () => {
    render(<Layout />);
    expect(screen.queryByRole("dialog")).toBeNull();
    openSheet();
    expect(sheet()).toBeTruthy();
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useShortcutsSheet.getState().open).toBe(false);
  });

  it("opening the sheet focuses the dialog, not the switch", async () => {
    const user = userEvent.setup();
    render(<Layout />);
    openSheet();
    // Focus starts on the dialog itself: a screen reader begins at the title,
    // and Space or Enter cannot flip the persisted preference unseen.
    expect(document.activeElement).toBe(sheet());
    expect(useSingleKeyStore.getState().on).toBe(true);

    await user.keyboard(" ");
    await user.keyboard("{Enter}");

    expect(useSingleKeyStore.getState().on).toBe(true);
    expect(localStorage.getItem(SINGLE_KEYS_STORAGE_KEY)).toBeNull();
    expect(
      within(sheet())
        .getByRole("switch", { name: "Single-key shortcuts" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("lists this page's commands then Everywhere", () => {
    render(
      <Layout role="admin">
        <Page scope="viewer" commands={VIEWER} />
      </Layout>,
    );
    openSheet();
    const all = sections();
    expect(all.map((s) => s.heading)).toEqual([
      "On this page (Diff viewer)",
      "Everywhere",
    ]);
    const labels = (s: { rows: HTMLElement[] }) =>
      s.rows.map((r) => r.firstElementChild?.textContent);
    expect(labels(all[0]!)).toEqual(["Approve step", "Next step", "Fit"]);
    // The global commands this test cares about are all there, in this order;
    // a command added later does not break it.
    const everywhere = labels(all[1]!);
    const expected = [
      "Open command palette",
      "Keyboard shortcuts",
      "Search",
      "Undo last review action",
      "Go to Batches",
      "Go to Analytics",
      "Go to Projects",
    ];
    expect(everywhere).toEqual(expect.arrayContaining(expected));
    expect(everywhere.filter((l) => l && expected.includes(l))).toEqual(
      expected,
    );
  });

  it.each([
    ["batches", "On this page (Batches)"],
    ["batch", "On this page (Batch)"],
    ["viewer", "On this page (Diff viewer)"],
  ] as const)("names the %s page: %s", (scope, heading) => {
    render(
      <Layout>
        <Page
          scope={scope}
          commands={[command(scope, "x.one", "One thing", ["x"])]}
        />
      </Layout>,
    );
    openSheet();
    expect(sections().map((s) => s.heading)).toEqual([heading, "Everywhere"]);
  });

  it("has no page section on a page that registers nothing, or only commands with nothing to list", () => {
    render(<Layout />);
    openSheet();
    expect(sections().map((s) => s.heading)).toEqual(["Everywhere"]);
    cleanup();

    // A page whose every command is not allowed or has no key.
    render(
      <Layout role="guest">
        <Page
          scope="viewer"
          commands={[
            command("viewer", "review.approve", "Approve step", ["a"], {
              allowed: ({ role }) => canReviewRole(role),
            }),
            command("viewer", "viewer.palette", "Palette only", []),
          ]}
        />
      </Layout>,
    );
    openSheet();
    expect(sections().map((s) => s.heading)).toEqual(["Everywhere"]);
  });

  it("omits commands not allowed (guest: no Approve step)", () => {
    const page = <Page scope="viewer" commands={VIEWER} />;
    render(<Layout role="guest">{page}</Layout>);
    openSheet();
    const labels = within(sheet())
      .getAllByRole("listitem")
      .map((r) => r.firstElementChild?.textContent);
    expect(labels).not.toContain("Approve step");
    // Nor the undo a guest has none of (R9), nor the admin's navigation.
    expect(labels).not.toContain("Undo last review action");
    expect(labels).not.toContain("Go to Analytics");
    expect(labels).not.toContain("Go to Projects");
    // Still the ones a guest has.
    expect(labels).toEqual(
      expect.arrayContaining([
        "Next step",
        "Keyboard shortcuts",
        "Go to Batches",
      ]),
    );
    cleanup();

    // An editor reviews: Approve step and undo are listed; still no admin pages.
    useCommandRegistry.setState({ entries: [], role: "guest" });
    render(<Layout role="editor">{page}</Layout>);
    openSheet();
    expect(rowOf("Approve step")).toBeTruthy();
    expect(rowOf("Undo last review action")).toBeTruthy();
    expect(() => rowOf("Go to Analytics")).toThrow();
  });

  it("lists allowed-but-disabled commands", () => {
    render(
      <Layout>
        <Page
          scope="viewer"
          commands={[
            command("viewer", "review.approve", "Approve step", ["a"], {
              enabled: () => false,
            }),
          ]}
        />
      </Layout>,
    );
    openSheet();
    expect(keysOf(rowOf("Approve step"))).toEqual([["A"]]);
  });

  it("lists no command without keys: those are palette-only", () => {
    render(
      <Layout role="admin">
        <Page
          scope="viewer"
          commands={[command("viewer", "viewer.show", "Palette only", [])]}
        />
      </Layout>,
    );
    openSheet();
    const labels = within(sheet())
      .getAllByRole("listitem")
      .map((r) => r.firstElementChild?.textContent);
    expect(labels).not.toContain("Palette only");
    for (const paletteOnly of [
      "Toggle theme",
      "Turn single-key shortcuts off",
      "Turn single-key shortcuts on",
      "Replay tour",
    ]) {
      expect(labels, paletteOnly).not.toContain(paletteOnly);
    }
  });

  it("shows every key of a command, each in a kbd", () => {
    render(
      <Layout>
        <Page
          scope="batches"
          commands={[
            command("batches", "list.next", "Next row", [
              "j",
              { key: "ArrowDown", focusWithin: "[data-batches-list]" },
            ]),
            command("batches", "batches.open", "Open batch", ["Enter", "o"]),
          ]}
        />
      </Layout>,
    );
    openSheet();
    expect(keysOf(rowOf("Next row"))).toEqual([["J"], ["↓"]]);
    expect(keysOf(rowOf("Open batch"))).toEqual([["Enter"], ["O"]]);
    // Each key cap is a kbd.
    const caps = (label: string) =>
      Array.from(rowOf(label).querySelectorAll("kbd kbd")).map(
        (k) => k.textContent,
      );
    expect(caps("Next row")).toEqual(["J", "↓"]);
    expect(caps("Open batch")).toEqual(["Enter", "O"]);
  });

  it("sequence keys read G then I", () => {
    render(<Layout />);
    openSheet();
    const row = rowOf("Go to Batches");
    expect(keysOf(row)).toEqual([["G", "then", "I"]]);
    // Each key cap is a kbd; "then" is plain text between them.
    const caps = Array.from(row.querySelectorAll("kbd kbd")).map(
      (k) => k.textContent,
    );
    expect(caps).toEqual(["G", "I"]);
    expect(row.textContent).toContain("G then I");
  });

  it("shows ⌘ on a Mac and Ctrl elsewhere", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<Layout />);
    openSheet();
    expect(keysOf(rowOf("Open command palette"))).toEqual([["⌘", "K"]]);
    expect(keysOf(rowOf("Undo last review action"))).toEqual([["⌘", "Z"]]);
    cleanup();

    useCommandRegistry.setState({ entries: [], role: "guest" });
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    render(<Layout />);
    openSheet();
    expect(keysOf(rowOf("Open command palette"))).toEqual([["Ctrl", "K"]]);
  });

  it("every bound key appears in the sheet exactly once", () => {
    // Keys shared across scopes, on purpose: Batches' `/` takes the global
    // `/`, and the viewer's `j` takes Batches' (a command's other keys stay).
    render(
      <Layout role="admin">
        <Page
          scope="batches"
          commands={[
            command("batches", "list.next", "Next row", [
              "j",
              { key: "ArrowDown", focusWithin: "[data-batches-list]" },
            ]),
            command("batches", "search.focus", "Search batches", ["/"]),
          ]}
        />
        <Page
          scope="viewer"
          commands={[
            command("viewer", "viewer.nextPending", "Next pending step", ["j"]),
            ...VIEWER,
          ]}
        />
      </Layout>,
    );
    openSheet();

    const keyMap = resolveKeyMap(resolveCommands());
    expect(keyMap.size).toBeGreaterThan(10);
    const shown = shownKeys();

    // Nothing is shown that is not bound, and nothing twice…
    expect(shown).toHaveLength(keyMap.size);
    // …and every bound key is shown, under the command that wins it.
    for (const [identity, resolved] of keyMap) {
      const binding = findBinding(resolved.command, identity);
      expect(binding, identity).toBeDefined();
      const tokens = tokensOf(binding!);
      const matches = shown.filter(
        (s) =>
          s.label === resolved.command.label &&
          s.tokens.join("\u0000") === tokens.join("\u0000"),
      );
      expect(matches, `${resolved.command.id}: ${identity}`).toHaveLength(1);
    }
  });

  it("a key another scope takes is listed once, under the command that wins it", () => {
    render(
      <Layout>
        <Page
          scope="batches"
          commands={[
            command("batches", "search.focus", "Search batches", ["/"]),
          ]}
        />
      </Layout>,
    );
    openSheet();
    const slash = shownKeys().filter((k) => k.tokens.join("") === "/");
    expect(slash).toEqual([{ label: "Search batches", tokens: ["/"] }]);
    // The global command that lost its only key has no row.
    expect(() => rowOf("Search")).toThrow();
  });

  it("a command that keeps some keys is listed with those only", () => {
    render(
      <Layout>
        <Page
          scope="batches"
          commands={[
            command("batches", "list.next", "Next row", ["j", "ArrowDown"]),
          ]}
        />
        <Page
          scope="viewer"
          commands={[
            command("viewer", "viewer.nextPending", "Next pending step", ["j"]),
          ]}
        />
      </Layout>,
    );
    openSheet();
    expect(keysOf(rowOf("Next row"))).toEqual([["↓"]]);
    expect(keysOf(rowOf("Next pending step"))).toEqual([["J"]]);
  });

  it("a key two scopes spell differently is one key, listed once", () => {
    // "J" and "j" are one key to the dispatcher, and so to the sheet.
    render(
      <Layout>
        <Page
          scope="batches"
          commands={[command("batches", "list.next", "Next row", ["J"])]}
        />
        <Page
          scope="viewer"
          commands={[
            command("viewer", "viewer.nextPending", "Next pending step", ["j"]),
            command("viewer", "x.palette", "Palette, spelled differently", [
              "$mod+K",
            ]),
          ]}
        />
      </Layout>,
    );
    openSheet();
    expect(() => rowOf("Next row")).toThrow();
    expect(keysOf(rowOf("Next pending step"))).toEqual([["J"]]);
    // ⌘K, bound in capitals by the viewer, takes the global ⌘K.
    expect(() => rowOf("Open command palette")).toThrow();
    expect(keysOf(rowOf("Palette, spelled differently"))).toEqual([
      ["Ctrl", "K"],
    ]);
  });

  describe("the single-key switch", () => {
    it("adds no note while single-key shortcuts are on", () => {
      render(<Layout />);
      openSheet();
      expect(sheet().textContent).not.toContain(NOTE);
    });

    it("notes character keys, and only them, while it is off", () => {
      useSingleKeyStore.setState({ on: false });
      render(<Layout role="admin" />);
      openSheet();
      // ⌘K and ⌘Z are not character keys; ? / g i are.
      for (const label of ["Open command palette", "Undo last review action"]) {
        expect(rowOf(label).textContent, label).not.toContain(NOTE);
      }
      for (const label of ["Keyboard shortcuts", "Search", "Go to Batches"]) {
        expect(rowOf(label).textContent, label).toContain(NOTE);
      }
    });

    it("puts the note on the character keys of a mixed row, not on the arrow", () => {
      useSingleKeyStore.setState({ on: false });
      render(
        <Layout>
          <Page
            scope="batches"
            commands={[
              command("batches", "list.next", "Next row", ["j", "ArrowDown"]),
            ]}
          />
        </Layout>,
      );
      openSheet();
      const row = rowOf("Next row");
      // Both keys are shown…
      expect(keysOf(row)).toEqual([["J"], ["↓"]]);
      // …J carries the note, ↓ does not.
      const [j, down] = Array.from(row.querySelectorAll("kbd")).filter(
        (k) => k.parentElement?.closest("kbd") == null,
      );
      expect(j!.parentElement!.textContent).toContain(NOTE);
      expect(down!.parentElement!.textContent).not.toContain(NOTE);
      expect(row.textContent!.split(NOTE)).toHaveLength(2);
    });

    it("the footer switch turns single-key shortcuts off", () => {
      render(<Layout />);
      openSheet();
      const sw = within(sheet()).getByRole("switch", {
        name: "Single-key shortcuts",
      });
      expect(sw.getAttribute("aria-checked")).toBe("true");
      expect(sheet().textContent).not.toContain(NOTE);

      fireEvent.click(sw);

      expect(useSingleKeyStore.getState().on).toBe(false);
      expect(localStorage.getItem(SINGLE_KEYS_STORAGE_KEY)).toBe("0");
      expect(sw.getAttribute("aria-checked")).toBe("false");
      expect(useReviewAnnouncer.getState().text).toBe(
        "Single-key shortcuts off",
      );
      // The sheet follows: the character-key rows now say so.
      expect(rowOf("Go to Batches").textContent).toContain(NOTE);

      fireEvent.click(sw);
      expect(useSingleKeyStore.getState().on).toBe(true);
      expect(sw.getAttribute("aria-checked")).toBe("true");
      expect(useReviewAnnouncer.getState().text).toBe(
        "Single-key shortcuts on",
      );
      expect(sheet().textContent).not.toContain(NOTE);
    });

    it("the switch reads off when single-key shortcuts already are", () => {
      useSingleKeyStore.setState({ on: false });
      render(<Layout />);
      openSheet();
      expect(
        within(sheet())
          .getByRole("switch", { name: "Single-key shortcuts" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });

    it("the switch carries its help text", () => {
      render(<Layout />);
      openSheet();
      const sw = within(sheet()).getByRole("switch", {
        name: "Single-key shortcuts",
      });
      const help = document.getElementById(
        sw.getAttribute("aria-describedby") ?? "",
      );
      expect(help?.textContent).toBe(HELP);
    });
  });

  describe("Replay tour", () => {
    const STEPS: TourStep[] = [{ target: "#nothing", content: "Hello" }];

    /** A page with a tour, and a probe of the tour's state. */
    function TourPage({ withTour }: { withTour: boolean }) {
      return withTour ? <WithTour /> : <Probe />;
    }
    function WithTour() {
      useTourSteps("inbox", STEPS);
      return <Probe />;
    }
    function Probe() {
      const { state } = useTour();
      return (
        <output data-testid="tour">
          {state.active ? "active" : "idle"}:{state.pageId ?? "none"}
        </output>
      );
    }
    function Tree({ withTour }: { withTour: boolean }) {
      return (
        <TourProvider>
          <Layout>
            <TourPage withTour={withTour} />
          </Layout>
        </TourProvider>
      );
    }

    it("is offered only when the page has a tour", () => {
      render(<Tree withTour={false} />);
      openSheet();
      expect(
        within(sheet()).queryByRole("button", { name: "Replay tour" }),
      ).toBeNull();
      cleanup();

      render(<Tree withTour />);
      openSheet();
      expect(
        within(sheet()).getByRole("button", { name: "Replay tour" }),
      ).toBeTruthy();
    });

    it("is not offered outside a tour provider", () => {
      render(<Layout />);
      openSheet();
      expect(
        within(sheet()).queryByRole("button", { name: "Replay tour" }),
      ).toBeNull();
    });

    it("Replay tour calls relaunch", () => {
      // A dismissed tour, which only a relaunch brings back.
      localStorage.setItem("furan:tour:dismissed:inbox", "1");
      render(<Tree withTour />);
      expect(screen.getByTestId("tour").textContent).toBe("idle:inbox");

      openSheet();
      fireEvent.click(
        within(sheet()).getByRole("button", { name: "Replay tour" }),
      );

      expect(screen.getByTestId("tour").textContent).toBe("active:inbox");
      expect(localStorage.getItem("furan:tour:dismissed:inbox")).toBeNull();
    });

    it("Replay tour closes the sheet, so the tour is not behind it", () => {
      render(<Tree withTour />);
      openSheet();
      fireEvent.click(
        within(sheet()).getByRole("button", { name: "Replay tour" }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(useShortcutsSheet.getState().open).toBe(false);
    });
  });

  it("? opens it, through the one dispatcher", () => {
    render(
      <Layout role="guest">
        <CommandDispatcher />
      </Layout>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "?",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(sheet()).toBeTruthy();
    expect(sections().map((s) => s.heading)).toEqual(["Everywhere"]);
  });

  it("follows the registry: a page that mounts later is listed", () => {
    const { rerender } = render(<Layout />);
    openSheet();
    expect(sections().map((s) => s.heading)).toEqual(["Everywhere"]);
    rerender(
      <Layout>
        <Page
          scope="batch"
          commands={[command("batch", "a", "Approve step", ["a"])]}
        />
      </Layout>,
    );
    expect(sections().map((s) => s.heading)).toEqual([
      "On this page (Batch)",
      "Everywhere",
    ]);
  });

  it("the sheet drops a page section when the page unmounts", () => {
    const page = (
      <Page
        scope="batch"
        commands={[command("batch", "batch.approve", "Approve step", ["a"])]}
      />
    );
    const { rerender } = render(<Layout>{page}</Layout>);
    openSheet();
    expect(sections().map((s) => s.heading)).toEqual([
      "On this page (Batch)",
      "Everywhere",
    ]);
    expect(rowOf("Approve step")).toBeTruthy();

    // The page goes away: its commands and its section go with it.
    rerender(<Layout />);
    expect(sections().map((s) => s.heading)).toEqual(["Everywhere"]);
    expect(() => rowOf("Approve step")).toThrow();
  });

  it("the sheet follows a role change while open", () => {
    const labels = () =>
      within(sheet())
        .getAllByRole("listitem")
        .map((r) => r.firstElementChild?.textContent);
    const { rerender } = render(<Layout role="guest" />);
    openSheet();
    expect(labels()).not.toContain("Undo last review action");
    expect(labels()).not.toContain("Go to Analytics");

    // Each rerender is a NEW element (a new role prop).
    rerender(<Layout role="admin" />);
    expect(labels()).toContain("Undo last review action");
    expect(labels()).toContain("Go to Analytics");
    expect(labels()).toContain("Go to Projects");

    rerender(<Layout role="editor" />);
    expect(labels()).toContain("Undo last review action");
    expect(labels()).not.toContain("Go to Analytics");

    rerender(<Layout role="guest" />);
    expect(labels()).not.toContain("Undo last review action");
  });
});
