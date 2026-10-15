"use client";

import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { tinykeys, type KeyBindingMap } from "tinykeys";

import { keyIsOwnedElsewhere } from "./guard";
import { bindingKey, bindingOptions, keyIdentity, lowerFirst } from "./keys";
import { singleKeysOn } from "./prefs";
import {
  findBinding,
  resolveCommands,
  resolveKeyMap,
  useRegisteredCommands,
  type ResolvedCommand,
} from "./registry";
import type { Command } from "./types";

/** "g i" is a sequence; "$mod+k", "?" and "Shift++" are one press. */
function isSequence(key: string): boolean {
  return /\s/.test(key.trim());
}

/**
 * The same key with Shift held, for a bare character that has no case: "?",
 * "/", "+", "0", "[". Matching is on `e.key` (spec §3.6), but tinykeys also
 * refuses a modifier the binding does not name, and many layouts need Shift
 * to type these (US "?", German "/", AZERTY digits). A letter gets none:
 * Shift makes it another key ("A"). Null for anything else.
 */
function shiftedTwin(key: string): string | null {
  if ([...key].length !== 1 || key.trim() === "") return null;
  if (key.toLowerCase() !== key.toUpperCase()) return null;
  return `Shift+${key}`;
}

/** Every key the active commands bind, as one key each, sorted. */
function activeKeys(commands: ResolvedCommand[]): string[] {
  const keys = new Set<string>();
  for (const { command } of commands) {
    for (const b of command.keys ?? []) keys.add(keyIdentity(bindingKey(b)));
  }
  return [...keys].sort();
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
    const result = command.run(ctx);
    if (result instanceof Promise) {
      result.catch(() => failed(command));
    }
  } catch {
    failed(command);
  }
}

/**
 * The tinykeys map for `keys`. Sequences come first: tinykeys runs every
 * binding a key press matches, in this order, so a sequence that completes
 * on "a" ("g a") runs, and calls `preventDefault`, before the single-key
 * "a" is checked, and the guard (rule 1) makes "a" yield. (Object key order
 * puts integer-like keys such as "0" first; no sequence ends in one.)
 */
function keyMap(keys: string[]): KeyBindingMap {
  const map: KeyBindingMap = {};
  const ordered = [
    ...keys.filter(isSequence),
    ...keys.filter((k) => !isSequence(k)),
  ];
  for (const key of ordered) map[key] = (e) => dispatch(e, key);
  for (const key of ordered) {
    const twin = shiftedTwin(key);
    // A command may bind the shifted key itself ("Shift++"): that one wins.
    if (twin !== null && !(twin in map)) map[twin] = (e) => dispatch(e, key);
  }
  return map;
}

/**
 * The one key listener of the dashboard (spec §3.3), mounted once in the
 * protected layout. It binds every key of the active, `allowed` commands
 * with a single `tinykeys(window, …)`, and binds again only when that set of
 * keys changes: a scope mounting with keys already bound, or a page
 * re-rendering, binds nothing. At a key press it finds the command by key
 * (most specific scope first), then applies the guard (spec §3.4, the
 * single-key switch included), then `enabled`, then `preventDefault()` and
 * `run`.
 */
export function CommandDispatcher(): null {
  const commands = useRegisteredCommands();
  const bound = useMemo(() => JSON.stringify(activeKeys(commands)), [commands]);

  useEffect(() => {
    const keys = JSON.parse(bound) as string[];
    if (keys.length === 0) return;
    return tinykeys(window, keyMap(keys));
  }, [bound]);

  return null;
}
