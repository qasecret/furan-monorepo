"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import { create } from "zustand";

import { ariaKeyShortcuts, formatKeyLabel, formatKeys } from "./keys";
import { usePlatform } from "./platform";
import type { Command, CommandCtx, CommandScope } from "./types";

import type { ViewerRole } from "@/lib/roles";

/** A registered command with the live ctx of the component that registered it. */
export interface ResolvedCommand {
  command: Command;
  /** Reads the registrant's ctx as of its latest render, plus the role. */
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
}

/**
 * Every mounted registrant's commands. A scope may have several registrants
 * (several components can call `useCommands` for one scope); each call is
 * its own entry. Only registering and unregistering change the store; a
 * registrant's re-render never does.
 */
export const useCommandRegistry = create<RegistryState>(() => ({
  entries: [],
}));

/** On a shared key the most specific scope wins. */
const SCOPE_RANK: Record<CommandScope, number> = {
  global: 0,
  batches: 1,
  batch: 2,
  viewer: 3,
};

let lastOwner = 0;

/** The first key `incoming` shares with another command of the same scope. */
function findSharedKey(
  scope: CommandScope,
  incoming: Command[],
  entries: RegistryEntry[],
): string | null {
  const holders = new Map<string, string>();
  for (const entry of entries) {
    if (entry.scope !== scope) continue;
    for (const { command } of entry.commands) {
      for (const key of command.keys ?? []) holders.set(key, command.id);
    }
  }
  for (const command of incoming) {
    for (const key of new Set(command.keys ?? [])) {
      const holder = holders.get(key);
      if (holder !== undefined) {
        return `Commands "${holder}" and "${command.id}" share the key "${key}" in the "${scope}" scope.`;
      }
      holders.set(key, command.id);
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
  const clash = findSharedKey(scope, commands, entries);
  if (clash) {
    if (process.env.NODE_ENV !== "production") throw new Error(clash);
    console.error(clash);
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

// Least privilege when no provider is mounted: decision commands stay hidden.
const RoleContext = createContext<ViewerRole>("guest");

/** Supplies the viewer's role to every command's ctx. Mounted in the protected layout. */
export function CommandRoleProvider({
  role,
  children,
}: {
  role: ViewerRole;
  children: ReactNode;
}): JSX.Element {
  return createElement(RoleContext.Provider, { value: role }, children);
}

export function useCommandRole(): ViewerRole {
  return useContext(RoleContext);
}

/**
 * Registers `commands` in `scope` while the calling component is mounted.
 *
 * - Commands are static per mount: they are read once, when it mounts.
 * - `ctx` is kept in a ref that every render refreshes, so `allowed`,
 *   `enabled` and `run` always see live state, and a re-render never touches
 *   the store.
 * - Two commands of one scope (from any registrants) may not share a key:
 *   development throws, production logs.
 */
export function useCommands<C extends CommandCtx>(
  scope: CommandScope,
  commands: Command<C>[],
  ctx: Omit<C, "role">,
): void {
  const role = useCommandRole();
  const live = useRef({ ctx, role });
  live.current = { ctx, role };

  useEffect(() => {
    const getCtx = () =>
      ({ ...live.current.ctx, role: live.current.role }) as C;
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
 */
export function resolveCommands(): ResolvedCommand[] {
  return resolveEntries(useCommandRegistry.getState().entries);
}

/**
 * Which command each key runs. On a key shared across scopes the most
 * specific scope wins (`viewer` > `batch` > `batches` > `global`),
 * whatever the order of `cmds`.
 */
export function resolveKeyMap(
  cmds: ResolvedCommand[],
): Map<string, ResolvedCommand> {
  const map = new Map<string, ResolvedCommand>();
  for (const resolved of cmds) {
    for (const key of resolved.command.keys ?? []) {
      const held = map.get(key);
      if (!held || SCOPE_RANK[resolved.scope] > SCOPE_RANK[held.scope]) {
        map.set(key, resolved);
      }
    }
  }
  return map;
}

/**
 * `resolveCommands()` for rendering. It re-renders on register and
 * unregister (and when the role changes), never on a registrant's re-render.
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
 * id is registered in several scopes, the most specific one is used.
 */
export function useCommandKeys(id: string): CommandKeys {
  const commands = useRegisteredCommands();
  const platform = usePlatform();
  return useMemo(() => {
    let found: ResolvedCommand | undefined;
    for (const resolved of commands) {
      if (resolved.command.id !== id) continue;
      if (!found || SCOPE_RANK[resolved.scope] > SCOPE_RANK[found.scope]) {
        found = resolved;
      }
    }
    const keys = found?.command.keys ?? [];
    const [first] = keys;
    if (first === undefined) return NO_KEYS;
    const aria = ariaKeyShortcuts(keys, platform);
    return {
      keys: formatKeys(keys, platform),
      ...(aria ? { ariaKeyShortcuts: aria } : {}),
      titleSuffix: ` (${formatKeyLabel(first, platform)})`,
    };
  }, [commands, id, platform]);
}
