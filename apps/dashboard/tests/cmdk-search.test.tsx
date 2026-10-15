/**
 * The ⌘K palette's search over batches and tests (spec §5.2): what it asks
 * and when (2 or more characters, after 150 ms of quiet), what it shows
 * (rows that open the batch or the test), and that a search that fails or is
 * slow never takes the commands away.
 *
 * The palette runs over a real tRPC client and cache whose server is a
 * function (`tests/trpc-backend.tsx`), so what is asked, in what order and
 * how it is answered is the test's to say.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  callsTo,
  createBackend,
  TrpcBackend,
  type Backend,
} from "./trpc-backend";

const { pushMock, undoMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  undoMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
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
  usePaletteSearch,
  type PaletteSearch,
} from "@/components/cmdk/use-palette-search";
import {
  useDiffViewerShortcuts,
  type ShortcutOptions,
} from "@/components/diff-viewer/useDiffViewerShortcuts";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  useCommandRegistry,
} from "@/lib/commands/registry";
import { useUndoStore } from "@/lib/review/use-undo-store";
import type { ViewerRole } from "@/lib/roles";

const PROJECTS: ProjectListItem[] = [{ id: "p1", name: "Acme" }];
/** Two projects and no default: there is no current project. */
const TWO_PROJECTS: ProjectListItem[] = [
  { id: "p1", name: "Acme" },
  { id: "p2", name: "Beta" },
];
const RECENT_A = "furan:palette:recent:user-a";

/** What the server answers a list with. */
function page(items: unknown[]) {
  return { items, nextCursor: null };
}

/** The fields of a batch the search reads. */
function build(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: null,
    testName: null,
    number: null,
    ciBuildId: null,
    branchName: "main",
    pendingCheckpoints: 0,
    ...over,
  };
}

function variation(id: string, name: string) {
  return { id, name, branchName: null, browser: "chromium" };
}

let backend: Backend;
/** What the server holds: `builds.list` answers all of it, whatever the text. */
let builds: unknown[];
let variations: Array<{ id: string; name: string }>;

/** A server that serves `builds` and, filtered by `search`, `variations`. */
function serve() {
  backend.answer = async ({ path, input }) => {
    if (path === "builds.list") return page(builds);
    if (path === "variations.list") {
      const search = String(input.search ?? "").toLowerCase();
      return page(
        variations
          .filter((v) => v.name.toLowerCase().includes(search))
          .slice(0, Number(input.limit)),
      );
    }
    throw new Error(`unexpected call to ${path}`);
  };
}

function Shell({
  role = "editor",
  projects = PROJECTS,
  defaultProjectId = "p1",
  children,
}: {
  role?: ViewerRole;
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
          <CommandPalette userRole={role} userId="user-a" />
        </CurrentProjectProvider>
      </CommandRoleProvider>
    </TrpcBackend>
  );
}

function Viewer(opts: ShortcutOptions) {
  useDiffViewerShortcuts(opts);
  return null;
}

async function openPalette(): Promise<HTMLElement> {
  act(() => usePaletteStore.getState().setOpen(true));
  return screen.findByTestId("command-palette");
}

function typeSearch(text: string) {
  fireEvent.change(screen.getByTestId("command-input"), {
    target: { value: text },
  });
}

/** Moves fake time on, letting what it unblocks run. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The headings of the groups shown (cmdk hides a group, it does not remove it). */
function headings(palette: HTMLElement): string[] {
  return [
    ...palette.querySelectorAll(
      "[cmdk-group]:not([hidden]) [cmdk-group-heading]",
    ),
  ].map((h) => h.textContent ?? "");
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

/** Waits for a group to show exactly these rows. */
async function rows(palette: HTMLElement, heading: string, expected: string[]) {
  await waitFor(() => expect(labels(palette, heading)).toEqual(expected));
}

/** Lets the palette finish closing (Radix hands focus back a tick later). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  backend = createBackend();
  builds = [];
  variations = [];
  serve();
  pushMock.mockReset();
  undoMock.mockReset();
  useUndoStore.setState({ stack: [] });
  usePaletteStore.setState({ open: false });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  usePaletteStore.setState({ open: false });
  vi.restoreAllMocks();
});

describe("usePaletteSearch", () => {
  /** The hook over the backend, as the palette mounts it. */
  function mountHook(
    props: { projectId: string | null; text: string },
    options: { reactStrictMode?: boolean } = {},
  ) {
    return renderHook(
      ({ projectId, text }) => usePaletteSearch(projectId, text),
      {
        initialProps: props,
        wrapper: ({ children }) => (
          <TrpcBackend backend={backend}>{children}</TrpcBackend>
        ),
        ...options,
      },
    );
  }

  test("no search under 2 characters", async () => {
    const { result, rerender } = mountHook({ projectId: "p1", text: "" });
    vi.useFakeTimers();

    // One character, or one once the spaces are trimmed: nothing is asked,
    // however long it is left.
    for (const text of ["c", "  c ", " "]) {
      rerender({ projectId: "p1", text });
      await advance(1000);
      expect(backend.calls, JSON.stringify(text)).toEqual([]);
      expect(result.current.pending, JSON.stringify(text)).toBe(false);
    }

    // Two are enough.
    rerender({ projectId: "p1", text: "ca" });
    await advance(150);
    expect(callsTo(backend, "variations.list")).toHaveLength(1);
  });

  test("no search without a current project", async () => {
    const { result } = mountHook({ projectId: null, text: "cart" });
    vi.useFakeTimers();
    await advance(1000);
    expect(backend.calls).toEqual([]);
    expect(result.current).toEqual({
      batches: { items: [], error: false },
      tests: { items: [], error: false },
      pending: false,
    });
  });

  test("debounces 150 ms", async () => {
    const { result, rerender } = mountHook(
      { projectId: "p1", text: "" },
      { reactStrictMode: true },
    );
    vi.useFakeTimers();
    const asked = () => callsTo(backend, "variations.list");

    // Typed fast: each key restarts the wait, so "ca" and "car" are never
    // asked, however nearly 150 ms passed after them.
    rerender({ projectId: "p1", text: "ca" });
    await advance(149);
    expect(asked()).toEqual([]);
    expect(result.current.pending).toBe(true);
    // The batch list does not depend on the text: it is fetched once, from
    // the second character, not once per pause.
    expect(callsTo(backend, "builds.list")).toHaveLength(1);
    rerender({ projectId: "p1", text: "car" });
    await advance(149);
    expect(asked()).toEqual([]);
    rerender({ projectId: "p1", text: "cart" });
    await advance(149);
    expect(asked()).toEqual([]);
    expect(result.current.pending).toBe(true);

    // 150 ms after the last key: one question each, for what was typed.
    await advance(1);
    expect(asked()).toEqual([{ projectId: "p1", search: "cart", limit: 8 }]);
    expect(callsTo(backend, "builds.list")).toEqual([
      { projectId: "p1", limit: 100 },
    ]);
  });

  test("a stale answer never shows", async () => {
    // Each search is answered when the test says.
    const answers = new Map<string, (rows: unknown[]) => void>();
    backend.answer = ({ path, input }) =>
      path === "variations.list"
        ? new Promise((resolve) => {
            answers.set(String(input.search), (items) => resolve(page(items)));
          })
        : Promise.resolve(page([]));
    const { result, rerender } = mountHook({ projectId: "p1", text: "" });
    const asked = (search: string) =>
      waitFor(() =>
        expect(
          callsTo(backend, "variations.list").map((i) => i.search),
        ).toContain(search),
      );
    const answer = (search: string, ...names: string[]) =>
      act(async () => {
        answers.get(search)?.(names.map((n) => variation(`v-${n}`, n)));
      });
    const shown = () => result.current.tests.items.map((t) => t.name);

    // "ca" is answered after "car" was typed, while "car" is still asked.
    rerender({ projectId: "p1", text: "ca" });
    await asked("ca");
    rerender({ projectId: "p1", text: "car" });
    await asked("car");
    await answer("ca", "Ca test");
    expect(shown()).toEqual([]);
    expect(result.current.pending).toBe(true);
    await answer("car", "Car test");
    await waitFor(() => expect(shown()).toEqual(["Car test"]));
    expect(result.current.pending).toBe(false);

    // The other way round: the newer answer first, the older one late. While
    // the typing settles, the rows of the text before it are not this one's.
    rerender({ projectId: "p1", text: "cart" });
    expect(shown()).toEqual([]);
    await asked("cart");
    // And "Car test" is not kept up while "cart" is on its way.
    expect(shown()).toEqual([]);
    rerender({ projectId: "p1", text: "carts" });
    await asked("carts");
    await answer("carts", "Carts test");
    await waitFor(() => expect(shown()).toEqual(["Carts test"]));
    await answer("cart", "Cart test");
    expect(shown()).toEqual(["Carts test"]);

    // Back to a text answered before, which is in the cache: it is not shown
    // until the typing has settled either, and then it is.
    rerender({ projectId: "p1", text: "car" });
    expect(shown()).toEqual([]);
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(shown()).toEqual(["Car test"]));
    expect(result.current.pending).toBe(false);
  });

  test("going back to the settled text within the wait keeps its answer", async () => {
    backend.answer = async ({ path }) =>
      page(
        path === "variations.list"
          ? [variation("v1", "cart")]
          : [build("b1", { name: "cart" })],
      );
    const { result, rerender } = mountHook({ projectId: "p1", text: "" });
    vi.useFakeTimers();
    const shown = () => [
      result.current.batches.items.map((b) => b.name),
      result.current.tests.items.map((t) => t.name),
    ];

    rerender({ projectId: "p1", text: "cart" });
    await advance(150);
    await advance(10);
    expect(shown()).toEqual([["cart"], ["cart"]]);

    // Typed over, then put back before the wait is up: the answer to "cart"
    // is the answer again at once, and the wait for "ca" does not end it.
    // While "ca" waits, neither group shows what it matches.
    rerender({ projectId: "p1", text: "ca" });
    await advance(100);
    expect(shown()).toEqual([[], []]);
    expect(result.current.pending).toBe(true);
    rerender({ projectId: "p1", text: "cart" });
    expect(shown()).toEqual([["cart"], ["cart"]]);
    expect(result.current.pending).toBe(false);
    await advance(100);
    expect(shown()).toEqual([["cart"], ["cart"]]);
    expect(result.current.pending).toBe(false);
  });

  test("three successive searches fetch the batch list once", async () => {
    backend.answer = async ({ path }) =>
      page(path === "builds.list" ? [build("b1", { name: "cart" })] : []);
    const { result, rerender } = mountHook({ projectId: "p1", text: "" });
    vi.useFakeTimers();

    // Each text is typed and left to settle; one drops under the 2 characters
    // and comes back. The list of batches is the same for all of them.
    for (const text of ["ca", "car", "c", "cart"]) {
      rerender({ projectId: "p1", text });
      await advance(150);
      await advance(10);
    }
    expect(result.current.batches.items.map((b) => b.name)).toEqual(["cart"]);
    expect(callsTo(backend, "builds.list")).toHaveLength(1);
    // The tests are asked about what is typed: once for each text.
    expect(callsTo(backend, "variations.list").map((i) => i.search)).toEqual([
      "ca",
      "car",
      "cart",
    ]);
  });

  test("a 130-character query still searches tests", async () => {
    // `variations.list` takes a `search` of 120 characters at most and refuses
    // more (the server's zod bound).
    const name = "a".repeat(125);
    backend.answer = async ({ path, input }) => {
      if (path === "builds.list") return page([]);
      if (String(input.search).length > 120) throw new Error("too_big");
      return page(
        name.includes(String(input.search)) ? [{ id: "v1", name }] : [],
      );
    };
    const { result } = mountHook({ projectId: "p1", text: "a".repeat(130) });
    await waitFor(() => expect(result.current.pending).toBe(false));
    // Its first 120 characters were searched, and nothing failed.
    expect(callsTo(backend, "variations.list")).toEqual([
      { projectId: "p1", search: "a".repeat(120), limit: 8 },
    ]);
    expect(result.current.tests.error).toBe(false);
    expect(result.current.tests.items.map((t) => t.name)).toEqual([name]);
  });

  test("a failed search is its group's error, not a thrown one", async () => {
    backend.answer = async ({ path }) => {
      if (path === "builds.list") throw new Error("down");
      return page([variation("v1", "cart")]);
    };
    const { result } = mountHook({ projectId: "p1", text: "cart" });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.batches).toEqual({ items: [], error: true });
    expect(result.current.tests.error).toBe(false);
    expect(result.current.tests.items.map((t) => t.name)).toEqual(["cart"]);
  });
});

describe("a failed batch list", () => {
  /**
   * The hook over the backend, with every render it made: the one between a
   * search settling and its effects running is not on `result.current`.
   */
  function mountHook() {
    const renders: PaletteSearch[] = [];
    const hook = renderHook(
      ({ text }) => {
        const search = usePaletteSearch("p1", text);
        renders.push(search);
        return search;
      },
      {
        initialProps: { text: "" },
        wrapper: ({ children }) => (
          <TrpcBackend backend={backend}>{children}</TrpcBackend>
        ),
      },
    );
    return { ...hook, renders };
  }
  const asked = () => callsTo(backend, "builds.list").length;
  /** A search's text typed and left to settle. */
  async function settleOn(
    rerender: (props: { text: string }) => void,
    text: string,
  ) {
    rerender({ text });
    await advance(150);
    await advance(10);
  }

  test("a batch list that failed once is retried on the next search", async () => {
    // The list fails now and answers later; the question is held so the
    // moment between asking and answering can be seen.
    let healthy = false;
    let release: () => void = () => undefined;
    backend.answer = ({ path }) => {
      if (path === "variations.list") return Promise.resolve(page([]));
      if (!healthy) return Promise.reject(new Error("down"));
      return new Promise((resolve) => {
        release = () => resolve(page([build("b1", { name: "cart" })]));
      });
    };
    const { result, rerender, renders } = mountHook();
    vi.useFakeTimers();

    // The first search finds it down, and says so.
    await settleOn(rerender, "ca");
    expect(asked()).toBe(1);
    expect(result.current.batches).toEqual({ items: [], error: true });
    expect(result.current.pending).toBe(false);

    // It is back, but the same search stands: no new question, the failure
    // stays as it was.
    healthy = true;
    await advance(2000);
    expect(asked()).toBe(1);
    expect(result.current.batches.error).toBe(true);

    // The next search asks the list again. While that is out, the old
    // failure is not shown (it is not this search's), from the first render
    // of the search on, and the search is pending...
    const before = renders.length;
    await settleOn(rerender, "cart");
    expect(asked()).toBe(2);
    expect(result.current.batches).toEqual({ items: [], error: false });
    expect(result.current.pending).toBe(true);
    expect(renders.slice(before).filter((r) => r.batches.error)).toEqual([]);

    // ...and then the rows are there.
    await act(async () => release());
    await advance(10);
    expect(result.current.batches.error).toBe(false);
    expect(result.current.batches.items.map((b) => b.name)).toEqual(["cart"]);
    expect(result.current.pending).toBe(false);
    expect(asked()).toBe(2);
  });

  test("a list that keeps failing is asked once per search, not in a loop", async () => {
    backend.answer = async ({ path }) => {
      if (path === "builds.list") throw new Error("down");
      return page([]);
    };
    const { result, rerender } = mountHook();
    vi.useFakeTimers();

    // Each search settles, shows the failure and is left alone for a while:
    // one question for it, however long it stands.
    for (const [i, text] of ["ca", "car", "cart"].entries()) {
      await settleOn(rerender, text);
      await advance(3000);
      expect(asked(), text).toBe(i + 1);
      expect(result.current.batches, text).toEqual({
        items: [],
        error: true,
      });
      expect(result.current.pending, text).toBe(false);
    }
  });

  test("a list that failed on refresh, with rows already loaded, is retried on the next search too", async () => {
    // The list loaded for the first search; a refresh when the window is
    // back in focus (it is stale after a while) then failed, and the rows it
    // had are not shown for a failed list.
    let failing = false;
    let release: () => void = () => undefined;
    backend.answer = ({ path }) => {
      if (path === "variations.list") return Promise.resolve(page([]));
      if (failing) return Promise.reject(new Error("down"));
      return new Promise((resolve) => {
        release = () => resolve(page([build("b1", { name: "cart" })]));
      });
    };
    const { result, rerender, renders } = mountHook();
    vi.useFakeTimers();

    await settleOn(rerender, "ca");
    await act(async () => release());
    await advance(10);
    expect(result.current.batches.items.map((b) => b.name)).toEqual(["cart"]);
    expect(asked()).toBe(1);

    failing = true;
    await advance(31_000);
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(10);
    expect(asked()).toBe(2);
    expect(result.current.batches).toEqual({ items: [], error: true });

    // The next search asks again; the failure is not shown while that is
    // out, though the rows are still held under it, and then the rows are
    // back.
    failing = false;
    const before = renders.length;
    await settleOn(rerender, "cart");
    expect(asked()).toBe(3);
    expect(result.current.batches.error).toBe(false);
    expect(result.current.pending).toBe(true);
    expect(renders.slice(before).filter((r) => r.batches.error)).toEqual([]);
    await act(async () => release());
    await advance(10);
    expect(result.current.batches.items.map((b) => b.name)).toEqual(["cart"]);
    expect(result.current.pending).toBe(false);
  });
});

describe("the palette's Batches and Tests", () => {
  test("batch and test rows render and navigate", async () => {
    builds = [
      build("b1", { name: "Checkout flow", pendingCheckpoints: 3 }),
      // Titled by its test; its search text is the title.
      build("b2", {
        testName: "checkout smoke",
        number: 42,
        branchName: "release/1.2",
      }),
      build("b3", { name: "Profile" }),
      // No branch: no branch part.
      build("b4", { name: "Nightly checkout", branchName: null }),
    ];
    variations = [
      { id: "v1", name: "checkout-payment-step" },
      { id: "v2", name: "Checkout header" },
      { id: "v3", name: "profile" },
    ];
    render(<Shell />);
    const palette = await openPalette();
    typeSearch("checkout");

    await rows(palette, "Batches", [
      "Checkout flow · main · 3 pending",
      "checkout smoke · release/1.2 · 0 pending",
      "Nightly checkout · 0 pending",
    ]);
    await rows(palette, "Tests", ["checkout-payment-step", "Checkout header"]);
    // Batches, then Tests, as in the spec.
    expect(headings(palette)).toEqual(["Batches", "Tests"]);
    expect(callsTo(backend, "builds.list")).toEqual([
      { projectId: "p1", limit: 100 },
    ]);
    expect(callsTo(backend, "variations.list")).toEqual([
      { projectId: "p1", search: "checkout", limit: 8 },
    ]);

    // A batch opens the batch; the palette closes.
    fireEvent.click(
      within(group(palette, "Batches")).getByRole("option", {
        name: "checkout smoke · release/1.2 · 0 pending",
      }),
    );
    expect(pushMock).toHaveBeenCalledOnce();
    expect(pushMock).toHaveBeenCalledWith("/projects/p1/builds/b2");
    expect(usePaletteStore.getState().open).toBe(false);
    await settle();

    // A test opens its variation page.
    const again = await openPalette();
    typeSearch("checkout");
    await rows(again, "Tests", ["checkout-payment-step", "Checkout header"]);
    fireEvent.click(
      within(group(again, "Tests")).getByRole("option", {
        name: "Checkout header",
      }),
    );
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pushMock).toHaveBeenLastCalledWith("/projects/p1/variations/v2");
    expect(usePaletteStore.getState().open).toBe(false);
  });

  test("at most 8 of each are shown", async () => {
    builds = Array.from({ length: 12 }, (_, i) =>
      build(`b${i}`, { name: `Cart ${i}` }),
    );
    variations = Array.from({ length: 12 }, (_, i) => ({
      id: `v${i}`,
      name: `cart ${i}`,
    }));
    render(<Shell />);
    const palette = await openPalette();
    typeSearch("cart");
    await waitFor(() => expect(labels(palette, "Tests")).toHaveLength(8));
    // The newest eight, in the order the server gave them.
    expect(labels(palette, "Batches")).toEqual(
      Array.from({ length: 8 }, (_, i) => `Cart ${i} · main · 0 pending`),
    );
    expect(labels(palette, "Tests")).toEqual(
      Array.from({ length: 8 }, (_, i) => `cart ${i}`),
    );
  });

  test("a batch found by branch name still shows although cmdk's matcher would drop it", async () => {
    // A trailing space is no part of the search (it is trimmed), but cmdk's
    // own matcher, handed the raw text, finds nothing in the label for it.
    builds = [build("b1", { name: "Nightly", branchName: "main" })];
    render(<Shell />);
    const palette = await openPalette();
    typeSearch("main ");
    await rows(palette, "Batches", ["Nightly · main · 0 pending"]);
    expect(within(palette).queryByText("No results")).toBeNull();
  });

  test("a test the server matched still shows although its name does not match the typed text", async () => {
    // The server's match is a SQL ILIKE, where `_` stands for any character:
    // "p_yment" finds "payment", which cmdk's matcher would not.
    variations = [{ id: "v1", name: "payment" }];
    backend.answer = async ({ path, input }) => {
      if (path === "builds.list") return page([]);
      const like = new RegExp(`^${String(input.search).replace("_", ".")}$`);
      return page(variations.filter((v) => like.test(v.name)));
    };
    render(<Shell />);
    const palette = await openPalette();
    typeSearch("p_yment");
    await rows(palette, "Tests", ["payment"]);
  });

  test("with no current project there are no search groups", async () => {
    builds = [build("b1", { name: "Checkout" })];
    variations = [{ id: "v1", name: "checkout" }];
    render(<Shell projects={TWO_PROJECTS} defaultProjectId={null} />);
    const palette = await openPalette();
    vi.useFakeTimers();
    typeSearch("checkout");
    await advance(1000);
    expect(backend.calls).toEqual([]);
    expect(headings(palette)).not.toContain("Batches");
    expect(headings(palette)).not.toContain("Tests");
  });

  test("a failed batch search shows Couldn't search batches and tests still render", async () => {
    variations = [{ id: "v1", name: "checkout" }];
    backend.answer = async ({ path, input }) => {
      if (path === "builds.list") throw new Error("down");
      return page(
        variations.filter((v) => v.name.includes(String(input.search))),
      );
    };
    render(<Shell />);
    const palette = await openPalette();
    typeSearch("checkout");

    await rows(palette, "Tests", ["checkout"]);
    // One row, in the group where the batches would be.
    expect(labels(palette, "Batches")).toEqual(["Couldn't search batches"]);
    const error = within(group(palette, "Batches")).getByRole("option");
    // It reports; it does nothing.
    expect(error.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(error);
    expect(pushMock).not.toHaveBeenCalled();
    expect(usePaletteStore.getState().open).toBe(true);
    // The error is not a result: one is counted, and the palette is not empty.
    expect(within(palette).queryByText("No results")).toBeNull();
    await waitFor(
      () =>
        expect(within(palette).getByRole("status").textContent).toBe(
          "1 result",
        ),
      { timeout: 2000 },
    );
    cleanup();
    act(() => usePaletteStore.setState({ open: false }));

    // And the other way round: the tests fail, the batches show.
    builds = [build("b1", { name: "checkout" })];
    backend.answer = async ({ path }) => {
      if (path === "variations.list") throw new Error("down");
      return page(builds);
    };
    render(<Shell />);
    const other = await openPalette();
    typeSearch("checkout");
    await rows(other, "Batches", ["checkout · main · 0 pending"]);
    await rows(other, "Tests", ["Couldn't search tests"]);
    // Again the error is not counted: the one batch is.
    await waitFor(
      () =>
        expect(within(other).getByRole("status").textContent).toBe("1 result"),
      { timeout: 2000 },
    );
  });

  test("a failed search is announced when nothing else matched, and No results is not shown over it", async () => {
    const rounds: Array<[failing: string[], said: string]> = [
      [["builds.list"], "Couldn't search batches"],
      [["variations.list"], "Couldn't search tests"],
      [
        ["builds.list", "variations.list"],
        "Couldn't search batches. Couldn't search tests",
      ],
    ];
    for (const [failing, said] of rounds) {
      backend = createBackend();
      backend.answer = async ({ path }) => {
        if (failing.includes(path)) throw new Error("down");
        return page([]);
      };
      render(<Shell />);
      const palette = await openPalette();
      typeSearch("zzzz");
      await waitFor(
        () =>
          expect(within(palette).getByRole("status").textContent).toBe(said),
        { timeout: 2000 },
      );
      // The error rows say it; "No results" does not say it again above them.
      expect(palette.querySelector("[cmdk-empty]")).toBeNull();
      expect(within(palette).queryByText("No results")).toBeNull();
      cleanup();
      act(() => usePaletteStore.setState({ open: false }));
    }
  });

  test("commands still work while search is failing", async () => {
    backend.answer = async () => {
      throw new Error("down");
    };
    const onApprove = vi.fn();
    render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={onApprove} />
      </Shell>,
    );
    const palette = await openPalette();
    typeSearch("approve");

    // Both searches fail, each said where its rows would be.
    await rows(palette, "Batches", ["Couldn't search batches"]);
    await rows(palette, "Tests", ["Couldn't search tests"]);
    // The page's commands are there, in the spec's order (Actions first),
    // and run.
    expect(headings(palette)).toEqual(["Actions", "Batches", "Tests"]);
    expect(labels(palette, "Actions")).toEqual(["Approve step"]);
    fireEvent.click(
      within(group(palette, "Actions")).getByRole("option", {
        name: "Approve step",
      }),
    );
    expect(usePaletteStore.getState().open).toBe(false);
    await settle();
    expect(onApprove).toHaveBeenCalledOnce();
  });

  test("commands and pages are found while the search is still out", async () => {
    // A server that never answers: the rest of the palette is unaffected.
    backend.answer = () => new Promise(() => undefined);
    render(
      <Shell role="editor">
        <Viewer viewports={[]} onApprove={vi.fn()} />
      </Shell>,
    );
    const palette = await openPalette();
    typeSearch("approve");
    await waitFor(() => expect(backend.calls).toHaveLength(2));
    expect(labels(palette, "Actions")).toEqual(["Approve step"]);
    expect(headings(palette)).not.toContain("Batches");
    expect(headings(palette)).not.toContain("Tests");
  });

  test("a batch or test opened from the palette is kept in Recent", async () => {
    builds = [build("b1", { name: "Checkout flow", pendingCheckpoints: 2 })];
    variations = [{ id: "v1", name: "checkout-payment-step" }];
    const first = render(<Shell />);
    let palette = await openPalette();
    typeSearch("checkout");
    await rows(palette, "Batches", ["Checkout flow · main · 2 pending"]);
    fireEvent.click(
      within(group(palette, "Batches")).getByRole("option", {
        name: /Checkout flow/,
      }),
    );
    await settle();
    palette = await openPalette();
    typeSearch("checkout");
    await rows(palette, "Tests", ["checkout-payment-step"]);
    fireEvent.click(
      within(group(palette, "Tests")).getByRole("option", {
        name: "checkout-payment-step",
      }),
    );
    await settle();

    // Kept by an id the palette does not own, with the name and the address.
    expect(JSON.parse(localStorage.getItem(RECENT_A) ?? "null")).toEqual([
      {
        id: "test:p1:v1",
        label: "checkout-payment-step",
        href: "/projects/p1/variations/v1",
      },
      {
        id: "batch:p1:b1",
        label: "Checkout flow",
        href: "/projects/p1/builds/b1",
      },
    ]);
    first.unmount();
    act(() => usePaletteStore.setState({ open: false }));

    // Listed under Recent the next time, and opened from there.
    pushMock.mockReset();
    render(<Shell />);
    palette = await openPalette();
    expect(labels(palette, "Recent")).toEqual([
      "checkout-payment-step",
      "Checkout flow",
    ]);
    fireEvent.click(
      within(group(palette, "Recent")).getByRole("option", {
        name: "Checkout flow",
      }),
    );
    expect(pushMock).toHaveBeenCalledWith("/projects/p1/builds/b1");
  });

  test("a navigation pick does not refocus the opener", async () => {
    builds = [build("b1", { name: "Checkout flow" })];
    render(
      <Shell>
        <button type="button">Somewhere</button>
      </Shell>,
    );
    const somewhere = screen.getByRole("button", { name: "Somewhere" });
    act(() => somewhere.focus());
    const palette = await openPalette();
    typeSearch("checkout");
    await rows(palette, "Batches", ["Checkout flow · main · 0 pending"]);
    fireEvent.click(
      within(group(palette, "Batches")).getByRole("option", {
        name: /Checkout flow/,
      }),
    );
    await settle();
    // The page it went to may have focused something of its own.
    expect(usePaletteStore.getState().open).toBe(false);
    expect(document.activeElement).not.toBe(somewhere);
  });

  test("no empty state or announcement while either search is out, and the count once both are back", async () => {
    // Each question is answered when the test says, by procedure, with nothing.
    const out = new Map<string, Array<() => void>>();
    backend.answer = ({ path }) =>
      new Promise((resolve) => {
        out.set(path, [...(out.get(path) ?? []), () => resolve(page([]))]);
      });
    const answer = (path: string) =>
      act(async () => {
        out.get(path)?.forEach((resolve) => resolve());
        out.delete(path);
      });
    const pastTheDelay = () =>
      new Promise((resolve) => setTimeout(resolve, 350));

    // One search out is enough to say nothing, whichever it is. A fresh
    // palette and cache for each: a search already answered once is not out.
    const rounds = [
      ["zzzz", "builds.list", "variations.list"],
      ["yyyy", "variations.list", "builds.list"],
    ] as const;
    for (const [text, first, second] of rounds) {
      out.clear();
      render(<Shell />);
      const palette = await openPalette();
      const status = within(palette).getByRole("status");
      const empty = () => palette.querySelector("[cmdk-empty]")?.textContent;

      typeSearch(text);
      await waitFor(() => expect(out.size).toBe(2));
      await pastTheDelay();
      expect(empty(), text).toBeUndefined();
      expect(status.textContent, text).toBe("");
      await answer(first);
      await pastTheDelay();
      expect(empty(), text).toBeUndefined();
      expect(status.textContent, text).toBe("");

      // Both answered, with nothing: now it is "No results".
      await answer(second);
      await waitFor(() => expect(empty()).toBe("No results"));
      await waitFor(() => expect(status.textContent).toBe("No results"), {
        timeout: 2000,
      });
      cleanup();
      act(() => usePaletteStore.setState({ open: false }));
    }
  });

  test("found rows are counted in the result count", async () => {
    builds = [build("b1", { name: "Checkout flow" })];
    variations = [
      { id: "v1", name: "checkout one" },
      { id: "v2", name: "checkout two" },
    ];
    render(<Shell />);
    const palette = await openPalette();
    typeSearch("checkout");
    await rows(palette, "Tests", ["checkout one", "checkout two"]);
    await waitFor(
      () =>
        expect(within(palette).getByRole("status").textContent).toBe(
          "3 results",
        ),
      { timeout: 2000 },
    );
  });
});
