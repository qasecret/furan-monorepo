import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
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
// The real tinykeys, watched: how often the dispatcher binds, and with what.
vi.mock("tinykeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tinykeys")>();
  return { ...actual, tinykeys: vi.fn(actual.tinykeys) };
});

import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  useCommandRegistry,
  useCommands,
} from "@/lib/commands/registry";
import type {
  Command,
  CommandCtx,
  CommandScope,
  KeyBinding,
} from "@/lib/commands/types";
import { useUndoStore } from "@/lib/review/use-undo-store";
import type { ViewerRole } from "@/lib/roles";

/** A registrant's own state, as a page would hand it to `useCommands`. */
interface TestCtx extends CommandCtx {
  value?: string;
  on?: boolean;
}

function command(
  scope: CommandScope,
  id: string,
  keys: KeyBinding[],
  extra: Partial<Command<TestCtx>> = {},
): Command<TestCtx> {
  return {
    id,
    label: id,
    group: "Review",
    keys,
    scope,
    run: vi.fn(),
    ...extra,
  };
}

function Registrant({
  scope,
  commands,
  ctx = {},
}: {
  scope: CommandScope;
  commands: Command<TestCtx>[];
  ctx?: Omit<TestCtx, "role">;
}) {
  useCommands<TestCtx>(scope, commands, ctx);
  return null;
}

/** The layout: the role, the dispatcher, and whatever the test mounts. */
function Layout({
  role = "editor",
  children,
}: {
  role?: ViewerRole;
  children?: ReactNode;
}) {
  return (
    <CommandRoleProvider role={role}>
      <CommandDispatcher />
      {children}
    </CommandRoleProvider>
  );
}

/** One registrant in its own root, as a page mounts its scope. */
function mount(
  scope: CommandScope,
  commands: Command<TestCtx>[],
  ctx: Omit<TestCtx, "role"> = {},
) {
  return render(<Registrant scope={scope} commands={commands} ctx={ctx} />);
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

/** How many times the dispatcher has bound its keys (two maps each time). */
function binds(): number {
  const calls = vi.mocked(tinykeys).mock.calls.length;
  expect(calls % 2, "tinykeys calls come in pairs").toBe(0);
  return calls / 2;
}

beforeEach(() => {
  useUndoStore.setState({ stack: [] });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  usePaletteStore.setState({ open: false });
  useShortcutsSheet.setState({ open: false });
  pushMock.mockReset();
  undoMock.mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(tinykeys).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("CommandDispatcher", () => {
  it("runs the matching command once", () => {
    const run = vi.fn();
    render(
      <CommandRoleProvider role="editor">
        <Registrant
          scope="viewer"
          commands={[command("viewer", "viewer.x", ["x"], { run })]}
          ctx={{ value: "v1" }}
        />
      </CommandRoleProvider>,
    );
    // Mounted under StrictMode after the commands are in: its effect binds,
    // unbinds and binds again, which must leave exactly one listener.
    render(<CommandDispatcher />, { reactStrictMode: true });

    const e = press("x");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ role: "editor", value: "v1" }),
      { key: "x" },
    );
    expect(e.defaultPrevented).toBe(true);

    // Another key runs nothing, and is left to the browser.
    expect(press("y").defaultPrevented).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("run receives the matched key", () => {
    // One command, several keys: `run` is told which one ran it (R22), as
    // the binding names it, whatever the event spelled.
    const run = vi.fn();
    render(<Layout />);
    mount("batch", [
      command("batch", "batch.open", [{ key: "Enter" }, "o", "?", "g x"], {
        run,
      }),
    ]);

    press("Enter");
    expect(run).toHaveBeenLastCalledWith(expect.anything(), { key: "Enter" });
    press("o");
    expect(run).toHaveBeenLastCalledWith(expect.anything(), { key: "o" });
    // Caps Lock: the binding's key, not the event's.
    press("O");
    expect(run).toHaveBeenLastCalledWith(expect.anything(), { key: "o" });
    // The Shift twin of a bare "?" runs as "?".
    press("?", { shiftKey: true });
    expect(run).toHaveBeenLastCalledWith(expect.anything(), { key: "?" });
    // A sequence, as written.
    press("g");
    press("x");
    expect(run).toHaveBeenLastCalledWith(expect.anything(), { key: "g x" });
    expect(run).toHaveBeenCalledTimes(5);
  });

  it("respects scope precedence", () => {
    const inGlobal = vi.fn();
    const inBatches = vi.fn();
    const inViewer = vi.fn();
    render(<Layout />);
    mount("global", [command("global", "g.x", ["x", "y"], { run: inGlobal })]);
    mount("batches", [command("batches", "b.x", ["x"], { run: inBatches })]);
    const viewer = mount("viewer", [
      command("viewer", "v.x", ["x"], { run: inViewer }),
    ]);

    press("x");
    expect(inViewer).toHaveBeenCalledTimes(1);
    expect(inBatches).not.toHaveBeenCalled();
    expect(inGlobal).not.toHaveBeenCalled();

    // A key only the global scope binds is still global's.
    press("y");
    expect(inGlobal).toHaveBeenCalledTimes(1);

    // With the viewer gone, the next most specific scope has `x`.
    viewer.unmount();
    press("x");
    expect(inBatches).toHaveBeenCalledTimes(1);
    expect(inGlobal).toHaveBeenCalledTimes(1);
  });

  it("A in one scope and a in another resolve by scope precedence", () => {
    // tinykeys matches "A" and "a" alike, so they are one key: the viewer's,
    // however each scope wrote it.
    for (const [viewerKey, globalKey] of [
      ["A", "a"],
      ["a", "A"],
    ] as const) {
      useCommandRegistry.setState({ entries: [], role: "guest" });
      const inViewer = vi.fn();
      const inGlobal = vi.fn();
      render(<Layout />);
      mount("viewer", [
        command("viewer", "review.approve", [viewerKey], { run: inViewer }),
      ]);
      mount("global", [
        command("global", "global.a", [globalKey], { run: inGlobal }),
      ]);

      press("a");
      // Caps Lock: "A" with no Shift is the same key.
      press("A");
      expect(inViewer, `viewer ${viewerKey}`).toHaveBeenCalledTimes(2);
      expect(inGlobal, `global ${globalKey}`).not.toHaveBeenCalled();
      // One binding, not one per spelling.
      expect(boundKeys()).toEqual(["a"]);
      cleanup();
    }
  });

  it("enabled=false: not run and default not prevented", () => {
    const run = vi.fn();
    const approve = command("viewer", "review.approve", ["a"], {
      run,
      enabled: (ctx) => ctx.on === true,
    });
    const tree = render(
      <Layout>
        <Registrant scope="viewer" commands={[approve]} ctx={{ on: false }} />
      </Layout>,
    );

    const off = press("a");
    expect(run).not.toHaveBeenCalled();
    expect(off.defaultPrevented).toBe(false);

    // `enabled` reads the live ctx at the key press.
    tree.rerender(
      <Layout>
        <Registrant scope="viewer" commands={[approve]} ctx={{ on: true }} />
      </Layout>,
    );
    const on = press("a");
    expect(run).toHaveBeenCalledTimes(1);
    expect(on.defaultPrevented).toBe(true);
  });

  it("a throwing command toasts Couldn't <label> and the next key still works", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secret = new Error("token=abc in the stack");
    const next = vi.fn();
    render(<Layout />);
    mount("viewer", [
      command("viewer", "review.approve", ["a"], {
        label: "Approve step",
        run: () => {
          throw secret;
        },
      }),
      command("viewer", "review.reject", ["r"], {
        label: "Reject step",
        run: () => Promise.reject(secret),
      }),
      command("viewer", "viewer.nextStep", ["n"], { run: next }),
    ]);

    press("a");
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't approve step");
    expect(warn).toHaveBeenLastCalledWith("command failed", "review.approve");

    // A rejected promise is caught the same way.
    press("r");
    await act(async () => {
      await Promise.resolve();
    });
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't reject step");
    expect(warn).toHaveBeenLastCalledWith("command failed", "review.reject");

    // The error's details never reach the console or the toast.
    for (const args of [
      ...warn.mock.calls,
      ...vi.mocked(toast.error).mock.calls,
    ]) {
      expect(args).not.toContain(secret);
      expect(JSON.stringify(args)).not.toContain("token=abc");
    }

    // The dispatcher keeps working: another key, and the failed one again.
    press("n");
    expect(next).toHaveBeenCalledTimes(1);
    press("a");
    expect(toast.error).toHaveBeenCalledTimes(3);
  });

  it("a failing command named as things stand (labelFor) toasts the name it ran under", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let collapsed = false;
    render(<Layout />);
    mount("viewer", [
      command("viewer", "viewer.rail.toggle", ["t"], {
        label: "Hide details",
        labelFor: () => (collapsed ? "Show details" : "Hide details"),
        run: () => {
          collapsed = !collapsed;
          throw new Error("half done");
        },
      }),
    ]);

    press("t");
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't hide details");
    press("t");
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't show details");
  });

  it("an enabled check that throws is reported, runs nothing and leaves the key alone", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const run = vi.fn();
    const next = vi.fn();
    render(<Layout />);
    mount("viewer", [
      command("viewer", "review.approve", ["a"], {
        label: "Approve step",
        enabled: () => {
          throw new Error("state gone");
        },
        run,
      }),
      command("viewer", "viewer.nextStep", ["n"], { run: next }),
    ]);

    const e = press("a");
    expect(run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't approve step");
    expect(warn).toHaveBeenLastCalledWith("command failed", "review.approve");
    press("n");
    expect(next).toHaveBeenCalledOnce();
  });

  it("a rejecting thenable is caught like a promise", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Not a native Promise: any thenable a command returns.
    const thenable = {
      then(_ok: () => void, fail: (e: unknown) => void) {
        fail(new Error("nope"));
      },
    } as unknown as Promise<void>;
    render(<Layout />);
    mount("viewer", [
      command("viewer", "review.reject", ["r"], {
        label: "Reject step",
        run: () => thenable,
      }),
    ]);

    press("r");
    await act(async () => {
      await Promise.resolve();
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenLastCalledWith("Couldn't reject step");
    expect(warn).toHaveBeenLastCalledWith("command failed", "review.reject");
  });

  it("rebinds only when the key set changes", () => {
    const run = vi.fn();
    const x = command("global", "g.x", ["x"], { run });
    const tree = render(
      <Layout>
        <Registrant scope="global" commands={[x]} ctx={{ value: "v1" }} />
      </Layout>,
    );
    expect(binds()).toBe(1);
    expect(boundKeys()).toEqual(["x"]);

    // A re-render with a new ctx (a new element) binds nothing again…
    tree.rerender(
      <Layout>
        <Registrant scope="global" commands={[x]} ctx={{ value: "v2" }} />
      </Layout>,
    );
    expect(binds()).toBe(1);
    // …and the bound handler still sees the new ctx.
    press("x");
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: "v2" }),
      { key: "x" },
    );

    // Another registrant whose keys are already bound changes the commands,
    // not the key set.
    const viewer = mount("viewer", [command("viewer", "v.x", ["x"])]);
    expect(binds()).toBe(1);

    // A new key rebinds, once, and drops the old listener.
    const y = mount("batches", [command("batches", "b.y", ["y"])]);
    expect(binds()).toBe(2);
    expect(boundKeys().sort()).toEqual(["x", "y"]);
    viewer.unmount();
    expect(binds()).toBe(2);
    run.mockClear();
    press("x");
    expect(run).toHaveBeenCalledTimes(1);

    // So does losing one.
    y.unmount();
    expect(binds()).toBe(3);
    expect(boundKeys()).toEqual(["x"]);
  });

  it("rebinds when a role change changes the allowed keys", () => {
    const adminOnly = command("global", "go.analytics", ["g a"], {
      allowed: ({ role }) => role === "admin",
    });
    const tree = render(
      <Layout role="editor">
        <Registrant scope="global" commands={[adminOnly]} />
      </Layout>,
    );
    // Not allowed, `g a` is not bound; its `g` is still a prefix (R8).
    expect(binds()).toBe(1);
    expect(boundKeys()).not.toContain("g a");
    expect(boundKeys()).toContain("g (\\S)");

    tree.rerender(
      <Layout role="admin">
        <Registrant scope="global" commands={[adminOnly]} />
      </Layout>,
    );
    expect(binds()).toBe(2);
    expect(boundKeys()).toContain("g a");

    // The same prefix from another sequence changes nothing.
    mount("viewer", [
      command("viewer", "viewer.other", ["g x"], { allowed: () => false }),
    ]);
    expect(binds()).toBe(2);
    // A new prefix, even of a command no one may run, rebinds.
    mount("viewer", [
      command("viewer", "viewer.zed", ["z x"], { allowed: () => false }),
    ]);
    expect(binds()).toBe(3);
    expect(boundKeys()).toContain("z (\\S)");
  });

  it("a completed sequence consumes its last key", () => {
    const approve = vi.fn();
    const prevChange = vi.fn();
    render(
      <Layout role="admin">
        <GlobalCommands />
        <Registrant
          scope="viewer"
          commands={[
            command("viewer", "review.approve", ["a"], { run: approve }),
            command("viewer", "viewer.prevRegion", ["p"], { run: prevChange }),
          ]}
        />
      </Layout>,
    );

    press("g");
    press("a");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenLastCalledWith("/analytics");
    expect(approve).not.toHaveBeenCalled();

    press("g");
    press("p");
    expect(pushMock).toHaveBeenLastCalledWith("/projects");
    expect(prevChange).not.toHaveBeenCalled();

    // On its own, `a` is still the viewer's.
    press("a");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(2);
  });

  it("g then 0 does not fit", () => {
    // "0" is an integer-like key: an object lists it before every other
    // key, so in one tinykeys map it would run before the sequences and the
    // prefix catch-alls had a chance to take it.
    const fit = vi.fn();
    render(
      <Layout role="editor">
        <GlobalCommands />
        <Registrant
          scope="viewer"
          commands={[command("viewer", "viewer.fit", ["0"], { run: fit })]}
        />
      </Layout>,
    );

    press("g");
    const zero = press("0");
    expect(fit).not.toHaveBeenCalled();
    expect(zero.defaultPrevented).toBe(true);
    // Nor with Shift, as a layout that needs it for digits sends it.
    press("g");
    press("0", { shiftKey: true });
    expect(fit).not.toHaveBeenCalled();

    // On its own, `0` fits.
    const own = press("0");
    expect(fit).toHaveBeenCalledTimes(1);
    expect(own.defaultPrevented).toBe(true);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("a disabled sequence's last key is swallowed", () => {
    const analytics = vi.fn();
    const approve = vi.fn();
    render(
      <Layout role="admin">
        <Registrant
          scope="global"
          commands={[
            command("global", "go.analytics", ["g a"], {
              run: analytics,
              enabled: () => false,
            }),
          ]}
        />
        <Registrant
          scope="viewer"
          commands={[
            command("viewer", "review.approve", ["a"], { run: approve }),
          ]}
        />
      </Layout>,
    );

    press("g");
    const a = press("a");
    // The sequence does not run, and its last key is still taken: the
    // viewer's `a` never sees it.
    expect(analytics).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(a.defaultPrevented).toBe(true);

    // On its own, `a` approves.
    press("a");
    expect(approve).toHaveBeenCalledTimes(1);
  });

  /** The layout's global keys and a viewer `a`, for the prefix tests. */
  function withViewerApprove(role: ViewerRole = "editor") {
    const approve = vi.fn();
    const tree = render(
      <Layout role={role}>
        <GlobalCommands />
        <input aria-label="Branch" />
        <Registrant
          scope="viewer"
          commands={[
            command("viewer", "review.approve", ["a"], { run: approve }),
          ]}
        />
      </Layout>,
    );
    return { approve, tree };
  }

  it("an editor's g then a in the viewer scope approves nothing and is prevented", () => {
    // `g a` is admin-only, so an editor has no such binding: `g` is still a
    // prefix, and the stray `a` after it is swallowed, not an approval.
    const { approve } = withViewerApprove("editor");

    press("g");
    const a = press("a");
    expect(approve).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(a.defaultPrevented).toBe(true);

    // A shifted character after `g` is swallowed too.
    press("g");
    const q = press("?", { shiftKey: true });
    expect(useShortcutsSheet.getState().open).toBe(false);
    expect(q.defaultPrevented).toBe(true);

    // On its own, `a` approves.
    press("a");
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("an admin's g a goes to /analytics only", () => {
    const { approve } = withViewerApprove("admin");

    press("g");
    const a = press("a");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenLastCalledWith("/analytics");
    expect(approve).not.toHaveBeenCalled();
    expect(a.defaultPrevented).toBe(true);
  });

  it("g then a typed in a text field is not prevented", () => {
    const { approve } = withViewerApprove("editor");
    act(() => screen.getByRole("textbox", { name: "Branch" }).focus());

    const g = press("g");
    const a = press("a");
    expect(g.defaultPrevented).toBe(false);
    expect(a.defaultPrevented).toBe(false);
    expect(approve).not.toHaveBeenCalled();

    // `g` on the page, then a click into the field and `a` within the
    // second: the `a` is typed, not swallowed.
    act(() => screen.getByRole("textbox", { name: "Branch" }).blur());
    press("g");
    act(() => screen.getByRole("textbox", { name: "Branch" }).focus());
    expect(press("a").defaultPrevented).toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  it("with single-key shortcuts off, g is no prefix", () => {
    useSingleKeyStore.setState({ on: false });
    const { approve } = withViewerApprove("editor");

    press("g");
    const a = press("a");
    expect(a.defaultPrevented).toBe(false);
    press("g");
    const q = press("?", { shiftKey: true });
    expect(q.defaultPrevented).toBe(false);
    expect(approve).not.toHaveBeenCalled();

    // A `g` pressed while the switch was off is no prefix, even if the
    // switch comes back on (from another tab) before the next key…
    press("g");
    act(() => useSingleKeyStore.setState({ on: true }));
    press("a");
    expect(approve).toHaveBeenCalledTimes(1);

    // …and a key pressed once it is off is not taken, whatever came before.
    press("g");
    act(() => useSingleKeyStore.setState({ on: false }));
    expect(press("a").defaultPrevented).toBe(false);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("g then Tab or Escape is untouched", () => {
    const { approve } = withViewerApprove("editor");

    for (const key of ["Tab", "Escape", "Enter", "ArrowDown"]) {
      press("g");
      expect(press(key).defaultPrevented, key).toBe(false);
    }
    // The prefix is spent: `a` is the viewer's again.
    press("a");
    expect(approve).toHaveBeenCalledTimes(1);

    // A ⌘ / Ctrl chord after `g` is not swallowed either.
    press("g");
    press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(true);
  });

  it("the prefix expires after the sequence window", () => {
    vi.useFakeTimers();
    try {
      const { approve } = withViewerApprove("editor");

      press("g");
      act(() => {
        vi.advanceTimersByTime(1100);
      });
      const late = press("a");
      expect(approve).toHaveBeenCalledTimes(1);
      expect(late.defaultPrevented).toBe(true);

      // Within the window it is still swallowed.
      press("g");
      act(() => {
        vi.advanceTimersByTime(900);
      });
      press("a");
      expect(approve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("g typed in a field, focus moves, then i within 1 s does not navigate", () => {
    const { approve } = withViewerApprove("editor");
    const field = screen.getByRole("textbox", { name: "Branch" });
    act(() => field.focus());
    press("g");
    // A click elsewhere moves focus without a key press.
    act(() => field.blur());
    expect(document.activeElement).toBe(document.body);

    const i = press("i");
    expect(pushMock).not.toHaveBeenCalled();
    expect(i.defaultPrevented).toBe(false);
    // Nor is a stray key swallowed: that `g` was typing, not a prefix.
    act(() => field.focus());
    press("g");
    act(() => field.blur());
    const a = press("a");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(a.defaultPrevented).toBe(true);
  });

  it("? opens the sheet on a non-US layout", () => {
    render(
      <Layout>
        <GlobalCommands />
      </Layout>,
    );

    // AZERTY: "?" with no Shift reported.
    const bare = press("?", { shiftKey: false });
    expect(useShortcutsSheet.getState().open).toBe(true);
    expect(bare.defaultPrevented).toBe(true);

    // US: Shift+/ reports "?" with Shift held.
    useShortcutsSheet.setState({ open: false });
    const shifted = press("?", { shiftKey: true });
    expect(useShortcutsSheet.getState().open).toBe(true);
    expect(shifted.defaultPrevented).toBe(true);
  });

  it("/ with Shift still runs search.focus", () => {
    const tree = render(
      <Layout>
        <GlobalCommands />
      </Layout>,
    );

    // A layout that types "/" with Shift (German: Shift+7).
    press("/", { shiftKey: true });
    expect(usePaletteStore.getState().open).toBe(true);
    usePaletteStore.setState({ open: false });
    press("/");
    expect(usePaletteStore.getState().open).toBe(true);
    usePaletteStore.setState({ open: false });

    // A page that has a search box binds `/` in its own scope, and wins.
    const focusSearch = vi.fn();
    tree.rerender(
      <Layout>
        <GlobalCommands />
        <Registrant
          scope="batches"
          commands={[
            command("batches", "search.focus", ["/"], { run: focusSearch }),
          ]}
        />
      </Layout>,
    );
    press("/", { shiftKey: true });
    expect(focusSearch).toHaveBeenCalledTimes(1);
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it("a letter binding does not fire with Shift held", () => {
    const approve = vi.fn();
    render(<Layout />);
    mount("viewer", [
      command("viewer", "review.approve", ["a"], { run: approve }),
    ]);

    const e = press("A", { shiftKey: true });
    expect(approve).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("a key bound with Shift itself is its own command's, not the bare key's", () => {
    // `+` bare, and `Shift++` as a US keyboard sends it, held by different
    // commands of one scope: the explicit binding is not overridden by the
    // bare key's Shift tolerance. (Across scopes it is a registration error.)
    const bare = vi.fn();
    const shifted = vi.fn();
    render(<Layout />);
    mount("viewer", [
      command("viewer", "viewer.plus", ["+"], { run: bare }),
      command("viewer", "viewer.zoomIn", ["Shift++"], { run: shifted }),
    ]);

    press("+", { shiftKey: true });
    expect(shifted).toHaveBeenCalledTimes(1);
    expect(bare).not.toHaveBeenCalled();
    press("+");
    expect(bare).toHaveBeenCalledTimes(1);
    expect(shifted).toHaveBeenCalledTimes(1);
  });

  it("single-key switch off: a does nothing, $mod+k still opens the palette", () => {
    useSingleKeyStore.setState({ on: false });
    const approve = vi.fn();
    render(
      <Layout>
        <GlobalCommands />
        <Registrant
          scope="viewer"
          commands={[
            command("viewer", "review.approve", ["a"], { run: approve }),
          ]}
        />
      </Layout>,
    );

    const a = press("a");
    expect(approve).not.toHaveBeenCalled();
    expect(a.defaultPrevented).toBe(false);
    // Nor does any other character key, or a sequence of them.
    press("?");
    expect(useShortcutsSheet.getState().open).toBe(false);
    press("g");
    press("i");
    expect(pushMock).not.toHaveBeenCalled();

    // jsdom is not a Mac: $mod is Ctrl.
    const k = press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(true);
    expect(k.defaultPrevented).toBe(true);
  });
});

describe("the done card passes the app's keys, not the page's (R33)", () => {
  /**
   * The layout's global keys, the viewer's page keys, the done card (a
   * non-modal dialog, holding focus as it does when it appears) and an
   * ordinary modal dialog.
   */
  function onTheDoneCard(role: ViewerRole = "editor") {
    const page = {
      a: vi.fn(),
      r: vi.fn(),
      j: vi.fn(),
      k: vi.fn(),
      ArrowRight: vi.fn(),
      ArrowLeft: vi.fn(),
      Enter: vi.fn(),
      Escape: vi.fn(),
    };
    render(
      <Layout role={role}>
        <GlobalCommands />
        <Registrant
          scope="viewer"
          commands={Object.entries(page).map(([key, run]) =>
            command("viewer", `viewer.${key}`, [key], { run }),
          )}
        />
        <div
          role="dialog"
          aria-label="Batch done"
          data-done-card=""
          data-non-modal=""
          tabIndex={-1}
        >
          <button type="button">Back to batch</button>
        </div>
        <div role="dialog" aria-label="Approve pending steps?">
          <button type="button">Cancel</button>
        </div>
      </Layout>,
    );
    act(() => screen.getByRole("button", { name: "Back to batch" }).focus());
    useUndoStore.setState({
      stack: [{ actionId: "a1", label: "Approved home", runIds: ["r1"] }],
    });
    return page;
  }

  it("⌘K opens the palette, ? the sheet, g i goes to Batches, ⌘Z undoes", () => {
    onTheDoneCard("editor");

    const k = press("k", { ctrlKey: true });
    expect(usePaletteStore.getState().open).toBe(true);
    expect(k.defaultPrevented).toBe(true);
    act(() => usePaletteStore.setState({ open: false }));

    const q = press("?", { shiftKey: true });
    expect(useShortcutsSheet.getState().open).toBe(true);
    expect(q.defaultPrevented).toBe(true);
    act(() => useShortcutsSheet.setState({ open: false }));

    // `/` is the global search here too (the viewer has none of its own).
    press("/");
    expect(usePaletteStore.getState().open).toBe(true);
    act(() => usePaletteStore.setState({ open: false }));

    // The prefix is recorded with the same exemption, or the sequence
    // could never complete in the card.
    const g = press("g");
    const i = press("i");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenLastCalledWith("/inbox");
    expect(i.defaultPrevented).toBe(true);
    expect(g.defaultPrevented).toBe(false);

    const z = press("z", { ctrlKey: true });
    expect(undoMock).toHaveBeenCalledTimes(1);
    expect(z.defaultPrevented).toBe(true);
  });

  it("an admin's g a and g p go from the card too", () => {
    onTheDoneCard("admin");

    press("g");
    press("a");
    expect(pushMock).toHaveBeenLastCalledWith("/analytics");
    press("g");
    press("p");
    expect(pushMock).toHaveBeenLastCalledWith("/projects");
    expect(pushMock).toHaveBeenCalledTimes(2);
  });

  it("a, r, j, k, the arrows, Enter and Esc stay the card's", () => {
    const page = onTheDoneCard("admin");

    for (const key of Object.keys(page)) {
      expect(press(key).defaultPrevented, key).toBe(false);
    }
    // Enter on the card itself, past its buttons, is the card's as well.
    act(() => screen.getByRole("dialog", { name: "Batch done" }).focus());
    expect(press("Enter").defaultPrevented).toBe(false);
    for (const [key, run] of Object.entries(page)) {
      expect(run, key).not.toHaveBeenCalled();
    }

    // An editor's `g` then `a`: no Analytics, and no approve either. The
    // prefix is the app's here, so the stray `a` is taken, as on the page.
    cleanup();
    const editor = onTheDoneCard("editor");
    press("g");
    expect(press("a").defaultPrevented).toBe(true);
    expect(editor.a).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("a modal dialog keeps ⌘K, ?, g i and ⌘Z", () => {
    onTheDoneCard("admin");
    act(() => screen.getByRole("button", { name: "Cancel" }).focus());

    expect(press("k", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("?", { shiftKey: true }).defaultPrevented).toBe(false);
    press("g");
    expect(press("i").defaultPrevented).toBe(false);
    expect(press("z", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(usePaletteStore.getState().open).toBe(false);
    expect(useShortcutsSheet.getState().open).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
    expect(undoMock).not.toHaveBeenCalled();
  });
});
