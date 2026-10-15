import type { Command, KeyBinding, Platform } from "./types";

/**
 * Key strings use tinykeys syntax: modifiers joined to the key with "+"
 * ("$mod+k", "Shift++"), and the steps of a sequence separated by spaces
 * ("g i"). These helpers classify and display them; they never bind anything.
 * A command's keys are `KeyBinding`s: a key string, or one with per-key
 * options. Every reader takes the key string out with `bindingKey`.
 */

/** The options that decide when one binding of a command fires. */
export interface BindingOptions {
  focusWithin?: string;
  repeat?: boolean;
  allowInDialog?: string;
  passesUndo?: boolean;
}

/** The key string of a binding: "a" for both "a" and `{ key: "a" }`. */
export function bindingKey(b: KeyBinding): string {
  return typeof b === "string" ? b : b.key;
}

/**
 * The options for one binding of `cmd`: a per-key `focusWithin` / `repeat`
 * overrides the command's own; the rest come from the command.
 */
export function bindingOptions(
  cmd: Pick<Command, "focusWithin" | "repeat" | "allowInDialog" | "passesUndo">,
  b: KeyBinding,
): BindingOptions {
  const own: Exclude<KeyBinding, string> | undefined =
    typeof b === "string" ? undefined : b;
  const focusWithin = own?.focusWithin ?? cmd.focusWithin;
  const repeat = own?.repeat ?? cmd.repeat;
  const { allowInDialog, passesUndo } = cmd;
  // Only the options that are set, so a spread never adds `undefined`s.
  return {
    ...(focusWithin !== undefined ? { focusWithin } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(allowInDialog !== undefined ? { allowInDialog } : {}),
    ...(passesUndo !== undefined ? { passesUndo } : {}),
  };
}

/** Modifiers that make a key press a shortcut rather than a typed character. */
const COMMAND_MODIFIERS = new Set(["$mod", "Control", "Meta", "Alt"]);

const MODIFIER_GLYPHS: Record<Platform, Record<string, string>> = {
  mac: {
    $mod: "⌘",
    Meta: "⌘",
    Control: "⌃",
    Alt: "⌥",
    Shift: "⇧",
  },
  other: {
    $mod: "Ctrl",
    Meta: "Meta",
    Control: "Ctrl",
    Alt: "Alt",
    Shift: "Shift",
  },
};

const KEY_GLYPHS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
};

/** Splits one step ("$mod+k", "Shift++") the way tinykeys parses it. */
function parseStep(step: string): { modifiers: string[]; key: string } {
  const parts = step.split(/\b\+/);
  const key = parts.pop() ?? "";
  return { modifiers: parts, key };
}

/** The steps of a key string: "g i" → ["g", "i"]; "$mod+k" → ["$mod+k"]. */
function stepsOf(key: string): string[] {
  return key.trim().split(/\s+/).filter(Boolean);
}

/** True for a single printable character ("a", "?", "+"). */
function isPrintable(key: string): boolean {
  return [...key].length === 1 && key.trim() !== "";
}

/**
 * True when `key` is one press of a single printable character, with at most
 * Shift held: "?", "/", "a", "[", "0", "Shift++". These are WCAG 2.1.4's
 * character-key shortcuts. Named keys (arrows, Enter, Esc, Home, Delete…),
 * anything with ⌘ / Ctrl / Alt, and sequences are not.
 */
export function isCharacterKey(key: string): boolean {
  const steps = stepsOf(key);
  if (steps.length !== 1) return false;
  const { modifiers, key: pressed } = parseStep(steps[0] ?? "");
  if (modifiers.some((m) => COMMAND_MODIFIERS.has(m))) return false;
  return isPrintable(pressed);
}

/**
 * True when a key, or every step of a sequence ("g i"), is a character key:
 * the binding the single-key switch turns off.
 */
export function isCharacterBinding(key: string): boolean {
  const steps = stepsOf(key);
  return steps.length > 0 && steps.every(isCharacterKey);
}

/**
 * True when every key of the command, and every step of each sequence
 * ("g i"), is a character key. False for a command with no keys.
 */
export function isCharacterKeyCommand(c: Pick<Command, "keys">): boolean {
  const keys = c.keys ?? [];
  return (
    keys.length > 0 && keys.every((b) => isCharacterBinding(bindingKey(b)))
  );
}

/**
 * The same string for keys tinykeys treats as one: a single-character key
 * is lower-cased in each step, so "A" and "a" (or "Shift+A" and "Shift+a")
 * compare equal.
 */
export function keyIdentity(key: string): string {
  return stepsOf(key)
    .map((step) => {
      const { modifiers, key: pressed } = parseStep(step);
      const k = isPrintable(pressed) ? pressed.toLowerCase() : pressed;
      return [...modifiers, k].join("+");
    })
    .join(" ");
}

function keyGlyph(key: string): string {
  return KEY_GLYPHS[key] ?? (isPrintable(key) ? key.toUpperCase() : key);
}

function stepTokens(step: string, platform: Platform): string[] {
  const { modifiers, key } = parseStep(step);
  return [
    ...modifiers.map((m) => MODIFIER_GLYPHS[platform][m] ?? m),
    keyGlyph(key),
  ];
}

/**
 * Display tokens, one array per key, each token one `kbd`:
 * "$mod+k" → ["⌘", "K"] on macOS, ["Ctrl", "K"] elsewhere; "g i" →
 * ["G", "then", "I"]; "ArrowUp" → ["↑"]; "Escape" → ["Esc"].
 */
export function formatKeys(keys: KeyBinding[], platform: Platform): string[][] {
  return keys.map((b) =>
    stepsOf(bindingKey(b)).flatMap((step, i) => [
      ...(i > 0 ? ["then"] : []),
      ...stepTokens(step, platform),
    ]),
  );
}

/**
 * One key as plain text, for a title: "A", "⌘Z" / "Ctrl+Z", "G then I".
 */
export function formatKeyLabel(key: string, platform: Platform): string {
  return stepsOf(key)
    .map((step) =>
      stepTokens(step, platform).join(platform === "mac" ? "" : "+"),
    )
    .join(" then ");
}

function ariaKey(key: string): string {
  if (key === "+") return "Plus";
  return isPrintable(key) ? key.toUpperCase() : key;
}

/**
 * The `aria-keyshortcuts` value: "$mod+k" → "Meta+K" on macOS, "Control+K"
 * elsewhere; ["r", "x"] → "R X". The attribute has no form for a sequence
 * (a space separates alternatives), so sequences are left out; the result is
 * "" when nothing is left.
 */
export function ariaKeyShortcuts(
  keys: KeyBinding[],
  platform: Platform,
): string {
  return keys
    .map((b) => stepsOf(bindingKey(b)))
    .filter((steps) => steps.length === 1)
    .map((steps) => {
      const { modifiers, key } = parseStep(steps[0] ?? "");
      return [
        ...modifiers.map((m) =>
          m === "$mod" ? (platform === "mac" ? "Meta" : "Control") : m,
        ),
        ariaKey(key),
      ].join("+");
    })
    .join(" ");
}

/** "Approve step" → "approve step", for "Couldn't approve step". */
export function lowerFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}
