import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindingOptions, formatKeys } from "@/lib/commands/keys";
import { usePlatform } from "@/lib/commands/platform";
import {
  CommandRoleProvider,
  resolveCommands,
  resolveKeyMap,
  useCommandKeys,
  useCommandRegistry,
  useCommands,
  useRegisteredCommands,
  type ResolvedCommand,
} from "@/lib/commands/registry";
import type {
  Command,
  CommandCtx,
  CommandScope,
  KeyBinding,
} from "@/lib/commands/types";
import { canReviewRole, type ViewerRole } from "@/lib/roles";

function withRole(role: ViewerRole) {
  return function RoleWrapper({ children }: { children: ReactNode }) {
    return createElement(CommandRoleProvider, { role, children });
  };
}

function command(
  scope: CommandScope,
  id: string,
  keys: KeyBinding[],
  extra: Partial<Command> = {},
): Command {
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

/** Mounts one `useCommands` registrant, as a page component would. */
function mount(
  scope: CommandScope,
  commands: Command[],
  role: ViewerRole = "editor",
) {
  return renderHook(() => useCommands(scope, commands, {}), {
    wrapper: withRole(role),
  });
}

function stubMac() {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  );
}

beforeEach(() => {
  useCommandRegistry.setState({ entries: [], role: "guest" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("command registry", () => {
  it("registers on mount and unregisters on unmount", () => {
    const approve = command("viewer", "review.approve", ["a"]);
    const { unmount } = renderHook(() => useCommands("viewer", [approve], {}), {
      wrapper: withRole("editor"),
      reactStrictMode: true,
    });

    // StrictMode mounts, unmounts and mounts again: one registrant remains.
    expect(useCommandRegistry.getState().entries).toHaveLength(1);
    const resolved = resolveCommands();
    expect(resolved.map((r) => r.command.id)).toEqual(["review.approve"]);
    expect(resolved[0]?.scope).toBe("viewer");
    expect(resolved[0]?.ctx()).toEqual({ role: "editor" });

    unmount();
    expect(useCommandRegistry.getState().entries).toHaveLength(0);
    expect(resolveCommands()).toEqual([]);

    // Unmounting one registrant removes only its own commands: not the
    // other registrant of the same scope, nor another scope's.
    const reject = mount("viewer", [command("viewer", "review.reject", ["r"])]);
    mount("viewer", [command("viewer", "viewer.next", ["n"])]);
    mount("global", [command("global", "go.batches", ["g i"])]);
    expect(resolveCommands().map((r) => r.command.id)).toEqual([
      "review.reject",
      "viewer.next",
      "go.batches",
    ]);
    reject.unmount();
    expect(resolveCommands().map((r) => r.command.id)).toEqual([
      "viewer.next",
      "go.batches",
    ]);
  });

  it("a re-render with new ctx does not re-register but run sees the new ctx", async () => {
    interface StepCtx extends CommandCtx {
      stepId: string;
    }
    const ran: StepCtx[] = [];
    const approve: Command<StepCtx> = {
      id: "review.approve",
      label: "Approve step",
      group: "Review",
      keys: ["a"],
      scope: "viewer",
      run: (ctx) => {
        ran.push(ctx);
      },
    };

    // A subscriber in its own root, so only a store change re-renders it.
    let subscriberRenders = 0;
    let subscriberSaw: ResolvedCommand[] = [];
    function Subscriber() {
      subscriberRenders += 1;
      subscriberSaw = useRegisteredCommands();
      return null;
    }
    render(createElement(Subscriber), { wrapper: withRole("editor") });

    const { rerender, unmount } = renderHook(
      ({ stepId }: { stepId: string }) =>
        useCommands<StepCtx>("viewer", [approve], { stepId }),
      { initialProps: { stepId: "s1" }, wrapper: withRole("editor") },
    );
    expect(subscriberSaw.map((r) => r.command.id)).toEqual(["review.approve"]);
    const rendersAfterRegister = subscriberRenders;

    const storeChanges = vi.fn();
    const unsubscribe = useCommandRegistry.subscribe(storeChanges);
    rerender({ stepId: "s2" });
    unsubscribe();

    expect(storeChanges).not.toHaveBeenCalled();
    expect(subscriberRenders).toBe(rendersAfterRegister);

    const [resolved] = resolveCommands();
    expect(resolved).toBeDefined();
    await resolved!.command.run(resolved!.ctx());
    expect(ran).toEqual([{ stepId: "s2", role: "editor" }]);

    // Unregistering does re-render the subscriber.
    unmount();
    expect(subscriberRenders).toBeGreaterThan(rendersAfterRegister);
    expect(subscriberSaw).toEqual([]);
  });

  it("allowed=false hides the command from resolveCommands", () => {
    const approve = command("viewer", "review.approve", ["a"], {
      allowed: (ctx) => canReviewRole(ctx.role),
    });

    const guest = mount("viewer", [approve], "guest");
    // Registered, but never resolved for a guest.
    expect(useCommandRegistry.getState().entries).toHaveLength(1);
    expect(resolveCommands()).toEqual([]);
    expect(resolveKeyMap(resolveCommands()).has("a")).toBe(false);
    const guestView = renderHook(() => useRegisteredCommands(), {
      wrapper: withRole("guest"),
    });
    expect(guestView.result.current).toEqual([]);
    guestView.unmount();
    guest.unmount();

    // `allowed` is evaluated against the live ctx at every resolve, never
    // once at registration: the role flips while the registration stays.
    function Registrant() {
      useCommands("viewer", [approve], {});
      return null;
    }
    const tree = (role: ViewerRole) =>
      createElement(CommandRoleProvider, {
        role,
        children: createElement(Registrant),
      });
    const { rerender } = render(tree("editor"));
    const ids = () => resolveCommands().map((r) => r.command.id);
    const registered = useCommandRegistry.getState().entries;
    expect(ids()).toEqual(["review.approve"]);
    rerender(tree("guest"));
    expect(ids()).toEqual([]);
    rerender(tree("editor"));
    expect(ids()).toEqual(["review.approve"]);
    // No re-registration happened along the way.
    expect(useCommandRegistry.getState().entries).toBe(registered);
  });

  it("allowed follows the registrant's live ctx with no store write", () => {
    interface EditCtx extends CommandCtx {
      canEdit: boolean;
    }
    const edit: Command<EditCtx> = {
      id: "editor.toggle",
      label: "Edit ignore regions",
      group: "Editor",
      keys: ["i"],
      scope: "viewer",
      allowed: (ctx) => ctx.canEdit,
      run: vi.fn(),
    };
    const { rerender } = renderHook(
      ({ canEdit }: { canEdit: boolean }) =>
        useCommands<EditCtx>("viewer", [edit], { canEdit }),
      { initialProps: { canEdit: true }, wrapper: withRole("editor") },
    );
    const ids = () => resolveCommands().map((r) => r.command.id);
    expect(ids()).toEqual(["editor.toggle"]);

    const storeChanges = vi.fn();
    const unsubscribe = useCommandRegistry.subscribe(storeChanges);
    rerender({ canEdit: false });
    expect(ids()).toEqual([]);
    rerender({ canEdit: true });
    expect(ids()).toEqual(["editor.toggle"]);
    unsubscribe();
    expect(storeChanges).not.toHaveBeenCalled();
  });

  it("a subscriber rendered before the registrant follows a role change both ways", () => {
    const approve = command("viewer", "review.approve", ["a"], {
      allowed: (ctx) => canReviewRole(ctx.role),
    });
    let listed: string[] = [];
    let hint: ReturnType<typeof useCommandKeys> | undefined;
    // Renders before the registrant in the same pass, so it can't rely on
    // the registrant's render to have seen the new role.
    function Hints() {
      listed = useRegisteredCommands().map((r) => r.command.id);
      hint = useCommandKeys("review.approve");
      return null;
    }
    function Registrant() {
      useCommands("viewer", [approve], {});
      return null;
    }
    const tree = (role: ViewerRole) =>
      createElement(CommandRoleProvider, {
        role,
        children: createElement(
          Fragment,
          null,
          createElement(Hints),
          createElement(Registrant),
        ),
      });
    const approveHint = {
      keys: [["A"]],
      ariaKeyShortcuts: "A",
      titleSuffix: " (A)",
    };

    const { rerender } = render(tree("editor"));
    expect(listed).toEqual(["review.approve"]);
    expect(hint).toEqual(approveHint);

    rerender(tree("guest"));
    expect(listed).toEqual([]);
    expect(hint).toStrictEqual({ keys: [], titleSuffix: "" });

    rerender(tree("editor"));
    expect(listed).toEqual(["review.approve"]);
    expect(hint).toEqual(approveHint);
  });

  it("CommandRoleProvider writes the role on its first client render", () => {
    // A layout effect alone would leave the store at "guest" for the tree
    // below's first render, so a button's hint would flash "no keys".
    const seen: ViewerRole[] = [];
    function Probe() {
      seen.push(useCommandRegistry.getState().role);
      return null;
    }
    render(
      createElement(CommandRoleProvider, {
        role: "editor",
        children: createElement(Probe),
      }),
    );
    expect(seen[0]).toBe("editor");
    expect(useCommandRegistry.getState().role).toBe("editor");
  });

  it("CommandRoleProvider resets the role to guest when it unmounts", () => {
    const { unmount } = render(
      createElement(CommandRoleProvider, { role: "admin", children: null }),
    );
    expect(useCommandRegistry.getState().role).toBe("admin");
    unmount();
    expect(useCommandRegistry.getState().role).toBe("guest");

    // A provider that replaces another in one commit keeps its own role: the
    // old one's cleanup must not win over the new one's write.
    const provider = (key: string, role: ViewerRole) =>
      createElement(CommandRoleProvider, { key, role, children: null });
    const tree = render(provider("a", "admin"));
    tree.rerender(provider("b", "editor"));
    expect(useCommandRegistry.getState().role).toBe("editor");
  });

  it("most specific scope wins on a shared key", () => {
    const at = (scope: CommandScope, id: string, keys: string[]) =>
      ({
        command: command(scope, id, keys),
        ctx: () => ({ role: "editor" }),
        scope,
      }) satisfies ResolvedCommand;
    const cmds = [
      at("global", "global.a", ["a", "$mod+k"]),
      at("viewer", "viewer.a", ["a"]),
      at("batches", "batches.a", ["a", "s", "j"]),
      at("batch", "batch.a", ["a", "s"]),
    ];

    // Registration order must not matter: check both orders.
    for (const order of [cmds, [...cmds].reverse()]) {
      const map = resolveKeyMap(order);
      expect(map.get("a")?.command.id).toBe("viewer.a");
      expect(map.get("s")?.command.id).toBe("batch.a");
      expect(map.get("j")?.command.id).toBe("batches.a");
      expect(map.get("$mod+k")?.command.id).toBe("global.a");
      expect([...map.keys()].sort()).toEqual(["$mod+k", "a", "j", "s"]);
    }

    // And through registration: viewer `a` beats global `a`.
    mount("viewer", [command("viewer", "review.approve", ["a"])]);
    mount("global", [command("global", "global.a", ["a"])]);
    const live = resolveKeyMap(resolveCommands()).get("a");
    expect(live?.command.id).toBe("review.approve");
    expect(live?.scope).toBe("viewer");
  });

  it("two commands in one scope may not share a key", () => {
    // React reports the effect's error to the console as well.
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    mount("viewer", [command("viewer", "review.approve", ["a"])]);
    // A second registrant in the same scope.
    expect(() =>
      mount("viewer", [command("viewer", "viewer.other", ["x", "a"])]),
    ).toThrow(/"a"/);
    // Two commands of one registrant.
    expect(() =>
      mount("batch", [
        command("batch", "batch.approve", ["a"]),
        command("batch", "batch.again", ["a"]),
      ]),
    ).toThrow(/"a"/);

    // The same key in another scope is fine (precedence decides).
    expect(() =>
      mount("global", [command("global", "global.a", ["a"])]),
    ).not.toThrow();
  });

  it("A and a in one scope are duplicates", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // tinykeys matches "A" and "a" alike.
    mount("viewer", [command("viewer", "review.approve", ["a"])]);
    expect(() =>
      mount("viewer", [command("viewer", "viewer.other", ["A"])]),
    ).toThrow(/"A"/);
    expect(() =>
      mount("batch", [
        command("batch", "batch.approve", ["Shift+a"]),
        command("batch", "batch.again", [{ key: "Shift+A" }]),
      ]),
    ).toThrow(/"Shift\+A"/);
  });

  it("the duplicate check normalises the existing holder's key too", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The holder is written "A", the newcomer "a": still one key.
    mount("viewer", [command("viewer", "review.approve", ["A"])]);
    expect(() =>
      mount("viewer", [command("viewer", "viewer.other", ["a"])]),
    ).toThrow(/review\.approve.*viewer\.other/);
  });

  it("one command may not bind the same key twice", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The same key in two cases, or once bare and once with an option.
    expect(() =>
      mount("viewer", [command("viewer", "review.approve", ["a", "A"])]),
    ).toThrow('Command "review.approve" binds the key "a" twice');
    expect(() =>
      mount("viewer", [
        command("viewer", "review.reject", [
          "a",
          { key: "a", focusWithin: "[data-list]" },
        ]),
      ]),
    ).toThrow('Command "review.reject" binds the key "a" twice');
    expect(useCommandRegistry.getState().entries).toHaveLength(0);

    // Two different keys, or one key used by two commands (another error),
    // are not this problem.
    expect(() =>
      mount("viewer", [command("viewer", "review.next", ["j", "ArrowDown"])]),
    ).not.toThrow();
  });

  it("a command registered under the wrong scope throws in development", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      mount("viewer", [command("global", "go.batches", ["g i"])]),
    ).toThrow(/go\.batches/);
    expect(useCommandRegistry.getState().entries).toHaveLength(0);
    expect(() =>
      mount("global", [command("global", "go.batches", ["g i"])]),
    ).not.toThrow();
  });

  it("a command can bind one key anywhere and another only within an element", () => {
    const down: KeyBinding = {
      key: "ArrowDown",
      focusWithin: "[data-batches-list]",
      repeat: true,
    };
    const next = command("batches", "list.next", ["j", down]);
    mount("batches", [next]);

    const map = resolveKeyMap(resolveCommands());
    expect([...map.keys()].sort()).toEqual(["ArrowDown", "j"]);
    expect(map.get("j")?.command.id).toBe("list.next");
    expect(map.get("ArrowDown")?.command.id).toBe("list.next");

    // `j` works anywhere; ArrowDown only in the list, and on auto-repeat.
    expect(bindingOptions(next, "j")).toEqual({});
    expect(bindingOptions(next, down)).toEqual({
      focusWithin: "[data-batches-list]",
      repeat: true,
    });
    // A per-key option overrides the command's own.
    const inList = command(
      "batch",
      "list.prev",
      ["k", { key: "ArrowUp", repeat: false }],
      {
        focusWithin: "[data-batch-list]",
        repeat: true,
      },
    );
    expect(bindingOptions(inList, "k")).toEqual({
      focusWithin: "[data-batch-list]",
      repeat: true,
    });
    expect(bindingOptions(inList, { key: "ArrowUp", repeat: false })).toEqual({
      focusWithin: "[data-batch-list]",
      repeat: false,
    });

    // Display and hints read the key out of each binding.
    expect(formatKeys(next.keys ?? [], "other")).toEqual([["J"], ["↓"]]);
    const { result } = renderHook(() => useCommandKeys("list.next"), {
      wrapper: withRole("editor"),
    });
    expect(result.current).toEqual({
      keys: [["J"], ["↓"]],
      ariaKeyShortcuts: "J ArrowDown",
      titleSuffix: " (J)",
    });
  });

  it("an object binding keeps the command's allowInDialog and passesUndo", () => {
    const undo = command("global", "review.undo", [{ key: "$mod+z" }], {
      allowInDialog: "[data-done-card]",
      passesUndo: true,
      focusWithin: "[data-list]",
    });
    expect(bindingOptions(undo, { key: "$mod+z" })).toEqual({
      focusWithin: "[data-list]",
      allowInDialog: "[data-done-card]",
      passesUndo: true,
    });
    // A per-key option overrides only its own field.
    expect(
      bindingOptions(undo, { key: "$mod+z", focusWithin: "[data-other]" }),
    ).toEqual({
      focusWithin: "[data-other]",
      allowInDialog: "[data-done-card]",
      passesUndo: true,
    });
  });

  it("useCommandKeys gives aria-keyshortcuts and a title suffix", () => {
    // The hint renders before its command registers (a button inside the
    // registering component), and updates once it does.
    const approveKeys = renderHook(() => useCommandKeys("review.approve"), {
      wrapper: withRole("editor"),
    });
    expect(approveKeys.result.current).toEqual({ keys: [], titleSuffix: "" });

    mount("viewer", [
      command("viewer", "review.approve", ["a"]),
      command("viewer", "review.reject", ["r", "x"]),
      command("viewer", "viewer.fit", []),
    ]);
    mount("global", [
      command("global", "go.batches", ["g i"]),
      command("global", "review.undo", ["$mod+z"]),
    ]);

    expect(approveKeys.result.current).toEqual({
      keys: [["A"]],
      ariaKeyShortcuts: "A",
      titleSuffix: " (A)",
    });

    const keysOf = (id: string) =>
      renderHook(() => useCommandKeys(id), { wrapper: withRole("editor") })
        .result.current;
    expect(keysOf("review.reject")).toEqual({
      keys: [["R"], ["X"]],
      ariaKeyShortcuts: "R X",
      titleSuffix: " (R)",
    });
    expect(keysOf("review.undo")).toEqual({
      keys: [["Ctrl", "Z"]],
      ariaKeyShortcuts: "Control+Z",
      titleSuffix: " (Ctrl+Z)",
    });
    // A sequence has no aria-keyshortcuts form, but keeps its title hint.
    expect(keysOf("go.batches")).toStrictEqual({
      keys: [["G", "then", "I"]],
      titleSuffix: " (G then I)",
    });
    // An unknown id, or a command with no keys: no hint at all.
    expect(keysOf("no.such.command")).toStrictEqual({
      keys: [],
      titleSuffix: "",
    });
    expect(keysOf("viewer.fit")).toStrictEqual({ keys: [], titleSuffix: "" });

    // On a Mac the modifiers are symbols.
    stubMac();
    expect(keysOf("review.undo")).toEqual({
      keys: [["⌘", "Z"]],
      ariaKeyShortcuts: "Meta+Z",
      titleSuffix: " (⌘Z)",
    });
  });

  it("useCommandKeys gives no hint for a command that is not allowed", () => {
    mount(
      "viewer",
      [
        command("viewer", "review.approve", ["a"], {
          allowed: (ctx) => canReviewRole(ctx.role),
        }),
      ],
      "guest",
    );
    const { result } = renderHook(() => useCommandKeys("review.approve"), {
      wrapper: withRole("guest"),
    });
    expect(result.current).toStrictEqual({ keys: [], titleSuffix: "" });
  });

  it("usePlatform renders other on the server and mac after hydration on a Mac UA", async () => {
    stubMac();
    function PlatformProbe() {
      return createElement("span", null, usePlatform());
    }

    // The server always renders "other", even on a Mac, so the client's
    // first (hydrating) render matches it.
    const html = renderToString(createElement(PlatformProbe));
    expect(html).toBe("<span>other</span>");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const hydrationErrors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await act(async () => {
      render(createElement(PlatformProbe), { container, hydrate: true });
    });

    expect(container.textContent).toBe("mac");
    expect(hydrationErrors).not.toHaveBeenCalled();
  });

  it("usePlatform is other on a non-Mac UA", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    const { result } = renderHook(() => usePlatform());
    expect(result.current).toBe("other");
  });
});
