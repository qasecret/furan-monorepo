import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  setSingleKeys,
  singleKeysOn,
  useSingleKeyShortcuts,
  useSingleKeyStore,
} from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  useCommandKeys,
  useCommandRegistry,
  useCommands,
} from "@/lib/commands/registry";
import type { Command, KeyBinding } from "@/lib/commands/types";
import { useReviewAnnouncer } from "@/lib/review/review-announcer";
import type { ViewerRole } from "@/lib/roles";

const STORAGE_KEY = "furan:keys:single";

function withRole(role: ViewerRole) {
  return function RoleWrapper({ children }: { children: ReactNode }) {
    return createElement(CommandRoleProvider, { role, children });
  };
}

function command(
  id: string,
  keys: KeyBinding[],
  scope: Command["scope"] = "viewer",
): Command {
  return { id, label: id, group: "Review", keys, scope, run: vi.fn() };
}

beforeEach(() => {
  window.localStorage.clear();
  useSingleKeyStore.setState({ on: true });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useReviewAnnouncer.setState({ text: "", seq: 0 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
  window.localStorage.clear();
});

/** A fresh copy of the module, as the page's first load would evaluate it. */
async function loadPrefs() {
  vi.resetModules();
  return import("@/lib/commands/prefs");
}

describe("single-key shortcuts switch", () => {
  it("defaults on", () => {
    expect(singleKeysOn()).toBe(true);
    const { result } = renderHook(() => useSingleKeyShortcuts());
    expect(result.current[0]).toBe(true);
    expect(typeof result.current[1]).toBe("function");

    // A fresh load with nothing stored is on too.
    return loadPrefs().then((fresh) => {
      expect(fresh.singleKeysOn()).toBe(true);
    });
  });

  it("persists to furan:keys:single", async () => {
    const { result } = renderHook(() => useSingleKeyShortcuts());

    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(singleKeysOn()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("0");

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(singleKeysOn()).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");

    // The next page load reads the stored choice back.
    window.localStorage.setItem(STORAGE_KEY, "0");
    expect((await loadPrefs()).singleKeysOn()).toBe(false);
    window.localStorage.setItem(STORAGE_KEY, "1");
    expect((await loadPrefs()).singleKeysOn()).toBe(true);
    // Anything else is the default.
    window.localStorage.setItem(STORAGE_KEY, "maybe");
    expect((await loadPrefs()).singleKeysOn()).toBe(true);
  });

  it("falls back to on when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect((await loadPrefs()).singleKeysOn()).toBe(true);

    // Writing is best effort: the switch still turns off for the session.
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const { result } = renderHook(() => useSingleKeyShortcuts());
    expect(() => act(() => result.current[1](false))).not.toThrow();
    expect(setItem).toHaveBeenCalled();
    expect(result.current[0]).toBe(false);
    expect(singleKeysOn()).toBe(false);
  });

  it("announces Single-key shortcuts off / on", () => {
    const { result } = renderHook(() => useSingleKeyShortcuts());
    const said = () => useReviewAnnouncer.getState().text;

    act(() => result.current[1](false));
    expect(said()).toBe("Single-key shortcuts off");
    act(() => result.current[1](true));
    expect(said()).toBe("Single-key shortcuts on");
    expect(useReviewAnnouncer.getState().seq).toBe(2);
  });

  it("renders on on the server and the stored choice after hydration", async () => {
    window.localStorage.setItem(STORAGE_KEY, "0");
    const fresh = await loadPrefs();
    expect(fresh.singleKeysOn()).toBe(false);

    function Probe() {
      const [on] = fresh.useSingleKeyShortcuts();
      return createElement("span", null, on ? "on" : "off");
    }

    // The server cannot know the stored choice, so the client's first
    // (hydrating) render must say the same, then correct itself.
    const html = renderToString(createElement(Probe));
    expect(html).toBe("<span>on</span>");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const hydrationErrors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await act(async () => {
      render(createElement(Probe), { container, hydrate: true });
    });

    expect(container.textContent).toBe("off");
    expect(hydrationErrors).not.toHaveBeenCalled();
    container.remove();
  });

  it("useCommandKeys drops character-key hints when the switch is off", () => {
    renderHook(
      () =>
        useCommands(
          "viewer",
          [
            command("review.approve", ["a"]),
            command("review.reject", ["r", "x"]),
            command("go.batches", ["g i"]),
          ],
          {},
        ),
      { wrapper: withRole("editor") },
    );
    renderHook(
      () =>
        useCommands(
          "global",
          [command("review.undo", ["$mod+z"], "global")],
          {},
        ),
      { wrapper: withRole("editor") },
    );
    const keysOf = (id: string) =>
      renderHook(() => useCommandKeys(id), { wrapper: withRole("editor") });

    const approve = keysOf("review.approve");
    const reject = keysOf("review.reject");
    const sequence = keysOf("go.batches");
    const undo = keysOf("review.undo");
    expect(approve.result.current).toEqual({
      keys: [["A"]],
      ariaKeyShortcuts: "A",
      titleSuffix: " (A)",
    });

    act(() => setSingleKeys(false));

    // Nothing left to show: no keys, no suffix, no aria at all.
    for (const hint of [approve, reject, sequence]) {
      expect(hint.result.current).toStrictEqual({ keys: [], titleSuffix: "" });
    }
    // ⌘Z is not a character key.
    expect(undo.result.current).toEqual({
      keys: [["Ctrl", "Z"]],
      ariaKeyShortcuts: "Control+Z",
      titleSuffix: " (Ctrl+Z)",
    });

    // And back.
    act(() => setSingleKeys(true));
    expect(approve.result.current.titleSuffix).toBe(" (A)");
    expect(reject.result.current).toEqual({
      keys: [["R"], ["X"]],
      ariaKeyShortcuts: "R X",
      titleSuffix: " (R)",
    });
    expect(sequence.result.current).toStrictEqual({
      keys: [["G", "then", "I"]],
      titleSuffix: " (G then I)",
    });
  });

  it("useCommandKeys keeps the other keys of a command when the switch is off", () => {
    renderHook(
      () =>
        useCommands(
          "batches",
          [
            command(
              "list.next",
              [
                "j",
                { key: "ArrowDown", focusWithin: "[data-list]", repeat: true },
              ],
              "batches",
            ),
            command("list.first", ["g", "Home"], "batches"),
          ],
          {},
        ),
      { wrapper: withRole("editor") },
    );
    const next = renderHook(() => useCommandKeys("list.next"), {
      wrapper: withRole("editor"),
    });
    const first = renderHook(() => useCommandKeys("list.first"), {
      wrapper: withRole("editor"),
    });
    expect(next.result.current).toEqual({
      keys: [["J"], ["↓"]],
      ariaKeyShortcuts: "J ArrowDown",
      titleSuffix: " (J)",
    });

    act(() => setSingleKeys(false));
    // Only the arrow is left, and the title names it.
    expect(next.result.current).toEqual({
      keys: [["↓"]],
      ariaKeyShortcuts: "ArrowDown",
      titleSuffix: " (↓)",
    });
    expect(first.result.current).toEqual({
      keys: [["Home"]],
      ariaKeyShortcuts: "Home",
      titleSuffix: " (Home)",
    });
  });
});
