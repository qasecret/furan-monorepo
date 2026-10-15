"use client";

import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { tinykeys, type KeyBindingMap } from "tinykeys";

import { keyIsOwnedElsewhere } from "./guard";
import {
  bindingKey,
  bindingOptions,
  keyIdentity,
  lowerFirst,
  shiftedTwin,
} from "./keys";
import { singleKeysOn } from "./prefs";
import {
  findBinding,
  resolveCommands,
  resolveKeyMap,
  useCommandRegistry,
  useRegisteredCommands,
  type ResolvedCommand,
} from "./registry";
import type { Command } from "./types";

/** "g i" is a sequence; "$mod+k", "?" and "Shift++" are one press. */
function isSequence(key: string): boolean {
  return /\s/.test(key.trim());
}

/** Every key the active commands bind, as one key each, sorted. */
function activeKeys(commands: ResolvedCommand[]): string[] {
  const keys = new Set<string>();
  for (const { command } of commands) {
    for (const b of command.keys ?? []) keys.add(keyIdentity(bindingKey(b)));
  }
  return [...keys].sort();
}

/**
 * The first step of every sequence any registrant binds ("g" of "g i"),
 * `allowed` or not, sorted: an editor's `g` is a prefix although `g a` is
 * not theirs, so the `a` after it is never taken for the viewer's approve.
 */
function sequencePrefixes(
  entries: readonly { commands: ResolvedCommand[] }[],
): string[] {
  const prefixes = new Set<string>();
  for (const { commands } of entries) {
    for (const { command } of commands) {
      for (const b of command.keys ?? []) {
        const key = keyIdentity(bindingKey(b));
        if (isSequence(key)) prefixes.add(key.split(" ")[0] ?? key);
      }
    }
  }
  return [...prefixes].sort();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function failed(command: Command): void {
  // The id only: an error's message or stack may carry data.
  console.warn("command failed", command.id);
  toast.error(`Couldn't ${lowerFirst(command.label)}`);
}

/**
 * One key press of `key` (a `keyIdentity`): the command that holds it now,
 * if the guard lets it and it is enabled, runs. A command that throws or
 * rejects is reported, and the next key press works as before.
 */
function dispatch(e: KeyboardEvent, key: string): void {
  // Resolved now, not when the keys were bound: `allowed` and the scopes
  // mounted are whatever they are at this press.
  const resolved = resolveKeyMap(resolveCommands()).get(key);
  if (!resolved) return;
  const { command } = resolved;
  const binding = findBinding(command, key);
  if (binding === undefined) return;
  const opts = bindingOptions(command, binding);
  if (keyIsOwnedElsewhere(e, key, opts, { singleKeys: singleKeysOn() })) {
    return;
  }
  try {
    const ctx = resolved.ctx();
    if (command.enabled && !command.enabled(ctx)) return;
    e.preventDefault();
    const result: unknown = command.run(ctx);
    // Any thenable, not only a native Promise.
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => failed(command));
    }
  } catch {
    failed(command);
  }
}

/**
 * A printable key that came after a sequence's first step (`prefix`) and
 * completed no sequence that ran: it is taken (`preventDefault`), so no
 * single-key command runs on it, and nothing else happens. When the guard
 * gives the key to something else (a text field, a dialog, the switch off),
 * it is left alone.
 */
function swallow(e: KeyboardEvent, prefix: string): void {
  if (!keyIsOwnedElsewhere(e, prefix, {}, { singleKeys: singleKeysOn() })) {
    e.preventDefault();
  }
}

/**
 * The tinykeys map for `keys` and the sequence `prefixes`. tinykeys runs
 * every binding a key press matches, in this order (object key order puts
 * integer-like keys such as "0" first; no sequence ends in one):
 *
 * 1. The sequences. One that completes on "a" ("g a") runs, and calls
 *    `preventDefault`, before anything else sees the "a".
 * 2. A catch-all per prefix: any other printable key after "g", bare or
 *    with Shift (`(\S)`: Tab, Esc, Enter and arrows are not swallowed),
 *    is swallowed. It shares tinykeys' sequence state and 1 s window.
 * 3. The single keys, then their Shift twins. After 1 or 2 took the key,
 *    the guard (rule 1) makes them yield.
 * 4. The prefixes themselves, noting whether the guard gave that press to
 *    something else: "g" typed in a field arms tinykeys' sequences all the
 *    same, so a sequence or a swallow that follows it (after a click moved
 *    focus) does nothing.
 */
function keyMap(keys: string[], prefixes: string[]): KeyBindingMap {
  let prefixOwned = false;
  const map: KeyBindingMap = {};
  const singles = keys.filter((k) => !isSequence(k));
  for (const key of keys.filter(isSequence)) {
    map[key] = (e) => {
      if (!prefixOwned) dispatch(e, key);
    };
  }
  for (const p of prefixes) {
    const stray = (e: KeyboardEvent) => {
      if (!prefixOwned) swallow(e, p);
    };
    map[`${p} (\\S)`] = stray;
    map[`${p} Shift+(\\S)`] = stray;
  }
  for (const key of singles) map[key] = (e) => dispatch(e, key);
  for (const key of singles) {
    const twin = shiftedTwin(key);
    // A command may bind the shifted key itself ("Shift++"): that one wins.
    if (twin !== null && !(twin in map)) map[twin] = (e) => dispatch(e, key);
  }
  for (const p of prefixes) {
    const own = map[p];
    map[p] = (e) => {
      // Before its own command (if any) runs and prevents the default.
      prefixOwned = keyIsOwnedElsewhere(
        e,
        p,
        {},
        { singleKeys: singleKeysOn() },
      );
      own?.(e);
    };
  }
  return map;
}

/**
 * The one key listener of the dashboard (spec §3.3), mounted once in the
 * protected layout. It binds every key of the active, `allowed` commands,
 * and the sequence prefixes of all of them (R8), with a single
 * `tinykeys(window, …)`, and binds again only when those keys or prefixes
 * change: a scope mounting with keys already bound, or a page re-rendering,
 * binds nothing. At a key press it finds the command by key (most specific
 * scope first), then applies the guard (spec §3.4, the single-key switch
 * included), then `enabled`, then `preventDefault()` and `run`.
 */
export function CommandDispatcher(): null {
  const entries = useCommandRegistry((s) => s.entries);
  const commands = useRegisteredCommands();
  const bound = useMemo(
    () =>
      JSON.stringify({
        keys: activeKeys(commands),
        prefixes: sequencePrefixes(entries),
      }),
    [commands, entries],
  );

  useEffect(() => {
    const { keys, prefixes } = JSON.parse(bound) as {
      keys: string[];
      prefixes: string[];
    };
    if (keys.length === 0 && prefixes.length === 0) return;
    return tinykeys(window, keyMap(keys, prefixes));
  }, [bound]);

  return null;
}
