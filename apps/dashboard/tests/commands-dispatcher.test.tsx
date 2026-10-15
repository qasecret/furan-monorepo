import { act, cleanup, render } from "@testing-library/react";
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

/** The keys of the dispatcher's latest tinykeys map. */
function boundKeys(): string[] {
  const call = vi.mocked(tinykeys).mock.calls.at(-1);
  return call ? Object.keys(call[1]) : [];
}

beforeEach(() => {
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
    );
    expect(e.defaultPrevented).toBe(true);

    // Another key runs nothing, and is left to the browser.
    expect(press("y").defaultPrevented).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
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

  it("rebinds only when the key set changes", () => {
    const run = vi.fn();
    const x = command("global", "g.x", ["x"], { run });
    const tree = render(
      <Layout>
        <Registrant scope="global" commands={[x]} ctx={{ value: "v1" }} />
      </Layout>,
    );
    expect(tinykeys).toHaveBeenCalledTimes(1);
    expect(boundKeys()).toEqual(["x"]);

    // A re-render with a new ctx (a new element) binds nothing again…
    tree.rerender(
      <Layout>
        <Registrant scope="global" commands={[x]} ctx={{ value: "v2" }} />
      </Layout>,
    );
    expect(tinykeys).toHaveBeenCalledTimes(1);
    // …and the bound handler still sees the new ctx.
    press("x");
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: "v2" }),
    );

    // Another registrant whose keys are already bound changes the commands,
    // not the key set.
    const viewer = mount("viewer", [command("viewer", "v.x", ["x"])]);
    expect(tinykeys).toHaveBeenCalledTimes(1);

    // A new key rebinds, once, and drops the old listener.
    const y = mount("batches", [command("batches", "b.y", ["y"])]);
    expect(tinykeys).toHaveBeenCalledTimes(2);
    expect(boundKeys().sort()).toEqual(["x", "y"]);
    viewer.unmount();
    expect(tinykeys).toHaveBeenCalledTimes(2);
    run.mockClear();
    press("x");
    expect(run).toHaveBeenCalledTimes(1);

    // So does losing one.
    y.unmount();
    expect(tinykeys).toHaveBeenCalledTimes(3);
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
    expect(tinykeys).not.toHaveBeenCalled();

    tree.rerender(
      <Layout role="admin">
        <Registrant scope="global" commands={[adminOnly]} />
      </Layout>,
    );
    expect(tinykeys).toHaveBeenCalledTimes(1);
    expect(boundKeys()).toEqual(["g a"]);
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
    // commands: the explicit binding is not overridden by the bare key's
    // Shift tolerance.
    const bare = vi.fn();
    const shifted = vi.fn();
    render(<Layout />);
    mount("global", [command("global", "g.plus", ["+"], { run: bare })]);
    mount("viewer", [
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
