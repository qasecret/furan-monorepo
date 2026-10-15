import { describe, expect, it } from "vitest";

import {
  ariaKeyShortcuts,
  formatKeys,
  isCharacterKey,
  isCharacterKeyCommand,
  lowerFirst,
} from "@/lib/commands/keys";

describe("command keys", () => {
  it("classifies character keys", () => {
    // One printable character, optionally shifted: WCAG 2.1.4's "character
    // key" shortcuts, which the single-key switch turns off.
    for (const key of ["?", "/", "a", "[", "0", "Shift++"]) {
      expect(isCharacterKey(key), key).toBe(true);
    }
    // Named keys and anything with ⌘ / Ctrl / Alt keep working.
    for (const key of [
      "ArrowUp",
      "Enter",
      "Escape",
      "Home",
      "End",
      "Delete",
      "Backspace",
      "$mod+z",
      "Shift+ArrowDown",
      "Control+a",
      "Alt+a",
      "Meta+a",
    ]) {
      expect(isCharacterKey(key), key).toBe(false);
    }
  });

  it("a command is character-key only when every key and sequence step is", () => {
    expect(isCharacterKeyCommand({ keys: ["g i"] })).toBe(true);
    expect(isCharacterKeyCommand({ keys: ["=", "+", "Shift++"] })).toBe(true);
    expect(isCharacterKeyCommand({ keys: ["a", "ArrowDown"] })).toBe(false);
    expect(isCharacterKeyCommand({ keys: ["g Enter"] })).toBe(false);
    expect(isCharacterKeyCommand({ keys: ["$mod+k"] })).toBe(false);
    expect(isCharacterKeyCommand({ keys: [] })).toBe(false);
    expect(isCharacterKeyCommand({})).toBe(false);
  });

  it("formats keys per platform", () => {
    expect(formatKeys(["$mod+k"], "mac")).toEqual([["⌘", "K"]]);
    expect(formatKeys(["$mod+k"], "other")).toEqual([["Ctrl", "K"]]);
    expect(formatKeys(["g i"], "mac")).toEqual([["G", "then", "I"]]);
    expect(formatKeys(["g i"], "other")).toEqual([["G", "then", "I"]]);
    expect(formatKeys(["ArrowUp"], "other")).toEqual([["↑"]]);
    expect(formatKeys(["ArrowDown", "ArrowLeft", "ArrowRight"], "mac")).toEqual(
      [["↓"], ["←"], ["→"]],
    );
    expect(formatKeys(["Shift++"], "mac")).toEqual([["⇧", "+"]]);
    expect(formatKeys(["Shift++"], "other")).toEqual([["Shift", "+"]]);
    expect(formatKeys(["Escape"], "mac")).toEqual([["Esc"]]);
    expect(formatKeys(["Enter"], "other")).toEqual([["Enter"]]);
    // Several keys for one command: one entry per key.
    expect(formatKeys(["r", "x"], "other")).toEqual([["R"], ["X"]]);
    expect(formatKeys([], "mac")).toEqual([]);
  });

  it("builds aria-keyshortcuts", () => {
    expect(ariaKeyShortcuts(["$mod+k"], "mac")).toBe("Meta+K");
    expect(ariaKeyShortcuts(["$mod+k"], "other")).toBe("Control+K");
    expect(ariaKeyShortcuts(["a"], "other")).toBe("A");
    expect(ariaKeyShortcuts(["r", "x"], "mac")).toBe("R X");
    expect(ariaKeyShortcuts(["Escape"], "mac")).toBe("Escape");
    expect(ariaKeyShortcuts(["Shift+ArrowDown"], "other")).toBe(
      "Shift+ArrowDown",
    );
    // ARIA spells the plus key "Plus".
    expect(ariaKeyShortcuts(["=", "+", "Shift++"], "other")).toBe(
      "= Plus Shift+Plus",
    );
    // aria-keyshortcuts has no syntax for a sequence: a space separates
    // alternatives, so "g i" would claim G and I each run the command.
    expect(ariaKeyShortcuts(["g i"], "mac")).toBe("");
    expect(ariaKeyShortcuts(["g i", "?"], "mac")).toBe("?");
  });

  it("lower-cases only the first letter of a label", () => {
    expect(lowerFirst("Approve step")).toBe("approve step");
    expect(lowerFirst("Go to Batches")).toBe("go to Batches");
    expect(lowerFirst("")).toBe("");
  });
});
