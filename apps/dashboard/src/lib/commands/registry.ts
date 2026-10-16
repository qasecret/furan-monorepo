"use client";

import {
  createElement,
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import { create } from "zustand";

import {
  ariaKeyShortcuts,
  bindingKey,
  formatKeyLabel,
  formatKeys,
  keyIdentity,
  liveBindings,
  shiftedTwin,
} from "./keys";
import { usePlatform } from "./platform";
import { useSingleKeyShortcuts } from "./prefs";
import type { Command, CommandCtx, CommandScope, KeyBinding } from "./types";

import type { ViewerRole } from "@/lib/roles";

/** A registered command with the live ctx of the component that registered it. */
export interface ResolvedCommand {
  command: Command;
  /**
   * Reads the registrant's ctx as of its latest render, with the registry's
   * current role.
   */
  ctx: () => CommandCtx;
  /** The scope it was registered in. */
  scope: CommandScope;
}

/** One `useCommands` call while its component is mounted. */
interface RegistryEntry {
  owner: number;
  scope: CommandScope;
  commands: ResolvedCommand[];
}

interface RegistryState {
  /** In registration order. Replaced (never mutated) on register/unregister. */
  entries: RegistryEntry[];
  /**
   * The viewer's role, set by `CommandRoleProvider`. Every command's ctx
   * reads it from here, so `allowed` follows a role change whichever
   * component renders first. "guest" (least privilege) until a provider sets it.
   */
  role: ViewerRole;
}

/**
 * Every mounted registrant's commands, and the role they are checked
 * against. A scope may have several registrants (several components can call
 * `useCommands` for one scope); each call is its own entry. Registering,
 * unregistering and a role change write the store; a registrant's re-render
 * never does.
 */
export const useCommandRegistry = create<RegistryState>(() => ({
  entries: [],
  role: "guest",
}));

/** On a shared key the most specific scope wins. */
const SCOPE_RANK: Record<CommandScope, number> = {
  global: 0,
  batches: 1,
  batch: 2,
  viewer: 3,
};

let lastOwner = 0;

/** Another scope's binding: who holds it, as written. */
interface Holder {
  id: string;
  key: string;
  scope: CommandScope;
}

/**
 * The key that, held by another scope, would take this one's Shift press (or
 * leave it with this one) whatever the scopes' precedence: a bare "?" and a
 * "Shift+?", since the dispatcher also binds "?" with Shift (`shiftedTwin`).
 */
function shiftCounterpart(identity: string): string | null {
  const twin = shiftedTwin(identity);
  if (twin !== null) return twin;
  const bare = identity.startsWith("Shift+") ? identity.slice(6) : null;
  return bare !== null && shiftedTwin(bare) === identity ? bare : null;
}

/**
 * What is wrong with registering `incoming` in `scope`: a command declaring
 * another scope, a key (compared as tinykeys matches it, so "A" is "a")
 * shared with another command of the same scope, one command binding a key
 * twice (its second binding's options would be dropped), or a bare character
 * here whose Shift form ("?" and "Shift+?") another scope binds. Null when
 * nothing is.
 */
function registrationProblem(
  scope: CommandScope,
  incoming: Command[],
  entries: RegistryEntry[],
): string | null {
  const misplaced = incoming.find((c) => c.scope !== scope);
  if (misplaced) {
    return `Command "${misplaced.id}" declares the "${misplaced.scope}" scope but is registered in the "${scope}" scope.`;
  }
  const holders = new Map<string, string>();
  const elsewhere = new Map<string, Holder>();
  for (const entry of entries) {
    for (const { command } of entry.commands) {
      for (const b of command.keys ?? []) {
        const key = bindingKey(b);
        if (entry.scope === scope) {
          holders.set(keyIdentity(key), command.id);
        } else {
          elsewhere.set(keyIdentity(key), {
            id: command.id,
            key,
            scope: entry.scope,
          });
        }
      }
    }
  }
  for (const command of incoming) {
    // Each key as first written, by identity, for this command alone.
    const own = new Map<string, string>();
    for (const b of command.keys ?? []) {
      const key = bindingKey(b);
      const identity = keyIdentity(key);
      const first = own.get(identity);
      if (first !== undefined) {
        return `Command "${command.id}" binds the key "${first}" twice.`;
      }
      own.set(identity, key);
      const holder = holders.get(identity);
      if (holder !== undefined) {
        return `Commands "${holder}" and "${command.id}" share the key "${key}" in the "${scope}" scope.`;
      }
      const counterpart = shiftCounterpart(identity);
      const other =
        counterpart === null ? undefined : elsewhere.get(counterpart);
      if (other !== undefined) {
        return `Command "${command.id}" binds "${key}" in the "${scope}" scope and "${other.id}" binds "${other.key}" in the "${other.scope}" scope: a key and its Shift form must be bound in one scope.`;
      }
      holders.set(identity, command.id);
    }
  }
  return null;
}

/** Adds one registrant; returns its removal. */
function register(
  scope: CommandScope,
  commands: Command[],
  ctx: () => CommandCtx,
): () => void {
  const { entries } = useCommandRegistry.getState();
  const problem = registrationProblem(scope, commands, entries);
  if (problem) {
    if (process.env.NODE_ENV !== "production") throw new Error(problem);
    console.error(problem);
  }
  const owner = ++lastOwner;
  const entry: RegistryEntry = {
    owner,
    scope,
    commands: commands.map((command) => ({ command, ctx, scope })),
  };
  useCommandRegistry.setState({ entries: [...entries, entry] });
  return () =>
    useCommandRegistry.setState((s) => ({
      entries: s.entries.filter((e) => e.owner !== owner),
    }));
}

/**
 * Supplies the viewer's role to every command's ctx. Mounted once, in the
 * protected layout. It writes the role into the registry: straight away on
 * its first client render, so the tree below renders with it, and in a
 * layout effect on every change, before paint. Unmounted, it puts the role
 * back to "guest".
 */
export function CommandRoleProvider({
  role,
  children,
}: {
  role: ViewerRole;
  children: ReactNode;
}): JSX.Element {
  const applied = useRef(false);
  // Client only: the server has no registered commands, and its module
  // store is shared between requests.
  if (!applied.current && typeof window !== "undefined") {
    applied.current = true;
    if (useCommandRegistry.getState().role !== role) {
      useCommandRegistry.setState({ role });
    }
  }
  useLayoutEffect(() => {
    useCommandRegistry.setState({ role });
  }, [role]);
  // Gone, the role goes with it: least privilege until a provider says
  // otherwise. A provider that replaces this one writes after this runs.
  useLayoutEffect(
    () => () => useCommandRegistry.setState({ role: "guest" }),
    [],
  );
  return createElement(Fragment, null, children);
}

/** The role commands are checked against. */
export function useCommandRole(): ViewerRole {
  return useCommandRegistry((s) => s.role);
}

/**
 * Registers `commands` in `scope` while the calling component is mounted.
 *
 * - Commands are static per mount: they are read once, when it mounts.
 * - `ctx` is kept in a ref that every render refreshes, so `allowed`,
 *   `enabled` and `run` always see live state, and a re-render never touches
 *   the store. The role comes from the registry (`CommandRoleProvider`).
 * - Development throws, and production logs, when a command declares another
 *   scope or two commands of one scope (from any registrants) share a key.
 */
export function useCommands<C extends CommandCtx>(
  scope: CommandScope,
  commands: Command<C>[],
  ctx: Omit<C, "role">,
): void {
  const live = useRef(ctx);
  live.current = ctx;

  useEffect(() => {
    const getCtx = () =>
      ({
        ...live.current,
        role: useCommandRegistry.getState().role,
      }) as C;
    // `commands` is deliberately not a dependency: it is static per mount.
    return register(scope, commands as unknown as Command[], getCtx);
  }, [scope]);
}

function isAllowed({ command, ctx }: ResolvedCommand): boolean {
  return command.allowed?.(ctx()) ?? true;
}

function resolveEntries(entries: RegistryEntry[]): ResolvedCommand[] {
  return entries.flatMap((e) => e.commands).filter(isAllowed);
}

/**
 * Every registered command that is `allowed` for its live ctx, in
 * registration order. A plain read (no React), e.g. for a key press.
 * `allowed` is evaluated now, so the list is a snapshot: a key press must
 * call `resolveKeyMap(resolveCommands())` at that moment.
 */
export function resolveCommands(): ResolvedCommand[] {
  return resolveEntries(useCommandRegistry.getState().entries);
}

/**
 * Which command each key runs, by `keyIdentity` ("A" and "a" are one key,
 * "a", as tinykeys matches them). On a key shared across scopes the most
 * specific scope wins (`viewer` > `batch` > `batches` > `global`),
 * whatever the order of `cmds` or how each scope spelled the key. The map is
 * only as fresh as `cmds`: at a key press, build it from a fresh
 * `resolveCommands()`, never from a list memoised at render time.
 */
export function resolveKeyMap(
  cmds: ResolvedCommand[],
): Map<string, ResolvedCommand> {
  const map = new Map<string, ResolvedCommand>();
  for (const resolved of cmds) {
    for (const b of resolved.command.keys ?? []) {
      const key = keyIdentity(bindingKey(b));
      const held = map.get(key);
      if (!held || SCOPE_RANK[resolved.scope] > SCOPE_RANK[held.scope]) {
        map.set(key, resolved);
      }
    }
  }
  return map;
}

/**
 * The binding of `command` that `key` (a `keyIdentity`, as `resolveKeyMap`
 * gives it) names, for its options (`bindingOptions`).
 */
export function findBinding(
  command: Command,
  key: string,
): KeyBinding | undefined {
  return command.keys?.find((b) => keyIdentity(bindingKey(b)) === key);
}

/**
 * The bindings a key press runs `resolved` with: those `winners` (a
 * `resolveKeyMap`) gives it, since another scope may take a key. With the
 * single-key switch off (`singleKeysOn` false), its character bindings are
 * left out too, as they do nothing (`liveBindings`); by default they are
 * kept, for a list that marks them off. The `?` sheet and the palette show
 * a command's keys from here.
 */
export function winningBindings(
  resolved: ResolvedCommand,
  winners: Map<string, ResolvedCommand>,
  singleKeysOn = true,
): KeyBinding[] {
  return liveBindings(resolved.command, singleKeysOn).filter(
    (b) => winners.get(keyIdentity(bindingKey(b))) === resolved,
  );
}

/**
 * `resolveCommands()` for rendering. It re-renders on register, unregister
 * and a role change, never on a registrant's re-render. Its `allowed` is a
 * snapshot from that render: use it to render, and resolve afresh
 * (`resolveCommands()`) when a key is pressed.
 */
export function useRegisteredCommands(): ResolvedCommand[] {
  const entries = useCommandRegistry((s) => s.entries);
  const role = useCommandRole();
  // `role` only invalidates the memo: `allowed` reads it through each ctx.
  return useMemo(() => resolveEntries(entries), [entries, role]);
}

export interface CommandKeys {
  /** Display tokens, one array per key (see `formatKeys`). */
  keys: string[][];
  /** Absent when the command has no key `aria-keyshortcuts` can express. */
  ariaKeyShortcuts?: string;
  /** " (A)", from the first key; "" when there is none. */
  titleSuffix: string;
}

const NO_KEYS: CommandKeys = { keys: [], titleSuffix: "" };

/**
 * A command's keys for a button that runs it: the `kbd` tokens, its
 * `aria-keyshortcuts` and a title suffix such as " (A)". No hint for an
 * unknown id, a command that isn't `allowed`, or one without keys. When an
 * id is registered in several scopes, the most specific one is used. With
 * the single-key switch off, character keys ("a", "j", "g i") are left out
 * of the hint, since they do nothing: a command with only those has no hint,
 * and one with others (`list.next`: J and ↓) shows just those.
 */
export function useCommandKeys(id: string): CommandKeys {
  const commands = useRegisteredCommands();
  const platform = usePlatform();
  const [singleKeys] = useSingleKeyShortcuts();
  return useMemo(() => {
    let found: ResolvedCommand | undefined;
    for (const resolved of commands) {
      if (resolved.command.id !== id) continue;
      if (!found || SCOPE_RANK[resolved.scope] > SCOPE_RANK[found.scope]) {
        found = resolved;
      }
    }
    const keys = found ? liveBindings(found.command, singleKeys) : [];
    const [first] = keys;
    if (first === undefined) return NO_KEYS;
    const aria = ariaKeyShortcuts(keys, platform);
    return {
      keys: formatKeys(keys, platform),
      ...(aria ? { ariaKeyShortcuts: aria } : {}),
      titleSuffix: ` (${formatKeyLabel(bindingKey(first), platform)})`,
    };
  }, [commands, id, platform, singleKeys]);
}
