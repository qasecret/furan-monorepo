"use client";

import { Command, defaultFilter, useCommandState } from "cmdk";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState, type JSX } from "react";

import { readRecent, recordRecent, type RecentEntry } from "./palette-recent";
import { usePaletteStore } from "./use-command-palette";

import {
  useCurrentProject,
  type ProjectListItem,
} from "@/app/(protected)/_components/current-project-provider";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  ariaKeyShortcuts,
  bindingKey,
  formatKeys,
  keyIdentity,
  liveBindings,
} from "@/lib/commands/keys";
import { usePlatform } from "@/lib/commands/platform";
import { useSingleKeyShortcuts } from "@/lib/commands/prefs";
import {
  resolveCommands,
  resolveKeyMap,
  useRegisteredCommands,
  type ResolvedCommand,
} from "@/lib/commands/registry";
import { runCommand } from "@/lib/commands/run-command";
import { isAtLeastAdmin, type ViewerRole } from "@/lib/roles";

// Style the cmdk group's heading slot only — putting these classes
// directly on `<Command.Group className>` propagates `uppercase` (and
// the other typography modifiers) down to the items, so every entry
// renders as ALL-CAPS. The `[&_[cmdk-group-heading]]:` arbitrary
// selector scopes them to the heading element cmdk emits inside the
// group wrapper.
const CMD_GROUP_CLASS =
  "[&_[cmdk-group-heading]]:text-xs " +
  "[&_[cmdk-group-heading]]:uppercase " +
  "[&_[cmdk-group-heading]]:tracking-wider " +
  "[&_[cmdk-group-heading]]:text-fg-muted " +
  "[&_[cmdk-group-heading]]:px-2 " +
  "[&_[cmdk-group-heading]]:pt-2";

const ITEM_CLASS =
  "flex items-center gap-3 px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-overlay-hover data-[selected=true]:bg-overlay-hover";

const KEY_CAP =
  "min-w-5 rounded border border-edge bg-sunken px-1 py-0.5 text-center font-mono text-xs text-fg-secondary";

/** `formatKeys`' word between the steps of a sequence ("G then I"). */
const SEQUENCE_WORD = "then";

/** The count is announced once typing has settled, not on every key. */
const ANNOUNCE_DELAY_MS = 300;

/** The admin pages in Go to, by their human names (spec §5.2). */
const ADMIN_PAGES: RecentEntry[] = [
  { label: "Members", href: "/admin/members" },
  { label: "Projects", href: "/admin/projects" },
  { label: "Installations", href: "/admin/installations" },
  { label: "API keys", href: "/admin/api-keys" },
  { label: "Auto rules", href: "/admin/auto-rules" },
  { label: "Audit log", href: "/admin/audit-log" },
];

const ACCOUNT_PAGES: RecentEntry[] = [
  { label: "API tokens", href: "/account/tokens" },
];

const ANALYTICS: RecentEntry = { label: "Analytics", href: "/analytics" };

/** "Jump to project: ‹name›": the project's batches (ADR-052: admins only). */
function projectJump({ id, name }: ProjectListItem): RecentEntry {
  return { label: `Jump to project: ${name}`, href: `/projects/${id}/builds` };
}

const PROJECT_JUMP = /^\/projects\/[^/]+\/builds$/;

/**
 * A page the palette offers admins only. A non-admin's Recent leaves these
 * out: the list of someone since demoted must not keep the admin pages, or
 * a way to switch projects (ADR-052).
 */
function isAdminPage(href: string): boolean {
  return (
    href === ANALYTICS.href ||
    ADMIN_PAGES.some((p) => p.href === href) ||
    PROJECT_JUMP.test(href)
  );
}

/**
 * Go to: Batches, Analytics (admins), the current project's Settings, then
 * the admin pages (admins).
 */
function goToPages(
  admin: boolean,
  currentProjectId: string | null,
): RecentEntry[] {
  return [
    { label: "Batches", href: "/inbox" },
    ...(admin ? [ANALYTICS] : []),
    ...(currentProjectId
      ? [{ label: "Settings", href: `/projects/${currentProjectId}/settings` }]
      : []),
    ...(admin ? ADMIN_PAGES : []),
  ];
}

/**
 * Where a global command sits in Preferences: the preferences, then help
 * (spec §5.2: Toggle theme, the single-key switch, Keyboard shortcuts,
 * Replay tour). Null: not listed there.
 */
function preferenceRank(id: string): number | null {
  if (id.startsWith("pref.")) return 0;
  if (id.startsWith("help.")) return 1;
  return null;
}

/** `enabled` for the live ctx; a throwing check counts as not enabled. */
function enabledNow({ command, ctx }: ResolvedCommand): boolean {
  try {
    return command.enabled?.(ctx()) ?? true;
  } catch {
    return false;
  }
}

/**
 * Matches what an item reads, its label (its only keyword), never its value:
 * a value is the item's unique id ("goto:/admin/members"), so that Recent's
 * "Members" and Go to's are two items, and typing "admin" finds no page by
 * its path.
 */
function byLabel(_value: string, search: string, keywords?: string[]): number {
  return defaultFilter(keywords?.join(" ") ?? "", search);
}

function resultCount(count: number): string {
  if (count === 0) return "No results";
  return count === 1 ? "1 result" : `${count} results`;
}

/**
 * The polite live region: "1 result" / "‹N› results" for what the typed
 * search shows (cmdk's filtered count), said once the typing has settled.
 * Quiet until something is typed, and again when the search is cleared.
 */
function ResultCount(): JSX.Element {
  const search = useCommandState((s) => s.search);
  const count = useCommandState((s) => s.filtered.count);
  const [settled, setSettled] = useState<{
    search: string;
    text: string;
  } | null>(null);
  useEffect(() => {
    const timer = setTimeout(
      () => setSettled({ search, text: resultCount(count) }),
      ANNOUNCE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [search, count]);
  // A count settled for another search is not this one's.
  const text =
    search.trim() !== "" && settled?.search === search ? settled.text : "";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {text}
    </div>
  );
}

/** A command's keys, right-aligned: a cap per token, "/" between keys. */
function Keys({ keys }: { keys: string[][] }): JSX.Element | null {
  if (keys.length === 0) return null;
  // Hidden from assistive technology: the item's `aria-keyshortcuts` says it.
  return (
    <span
      aria-hidden="true"
      className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-fg-muted"
    >
      {keys.map((tokens, i) => (
        <Fragment key={i}>
          {i > 0 && <span>/</span>}
          <kbd className="inline-flex items-center gap-1 font-sans">
            {tokens.map((token, j) =>
              token === SEQUENCE_WORD ? (
                <span key={j}>{token}</span>
              ) : (
                <kbd key={j} className={KEY_CAP}>
                  {token}
                </kbd>
              ),
            )}
          </kbd>
        </Fragment>
      ))}
    </span>
  );
}

function Item({
  value,
  label,
  keys = [],
  ariaKeys = "",
  onSelect,
}: {
  /** Unique across the palette; never matched (see `byLabel`). */
  value: string;
  label: string;
  keys?: string[][];
  ariaKeys?: string;
  onSelect: () => void;
}): JSX.Element {
  return (
    <Command.Item
      value={value}
      keywords={[label]}
      onSelect={onSelect}
      className={ITEM_CLASS}
      {...(ariaKeys ? { "aria-keyshortcuts": ariaKeys } : {})}
    >
      <span className="min-w-0 truncate">{label}</span>
      <Keys keys={keys} />
    </Command.Item>
  );
}

/** A listed command with the keys that run it now. */
interface CommandRow {
  resolved: ResolvedCommand;
  keys: string[][];
  ariaKeys: string;
}

interface Props {
  /**
   * The viewer's role, from the server-rendered layout's `/users/me`, so
   * admin-only pages and project jumps never reach editors or guests.
   */
  userRole: ViewerRole;
  /** Keys Recent to this user. Empty: Recent is neither read nor kept. */
  userId: string;
}

/**
 * The palette's content. It mounts each time the palette opens, so Recent
 * and the page's enabled commands are read afresh, and the search starts
 * empty.
 */
function PaletteBody({ userRole, userId }: Props): JSX.Element {
  const router = useRouter();
  const setOpen = usePaletteStore((s) => s.setOpen);
  const { currentProjectId, projects } = useCurrentProject();
  const commands = useRegisteredCommands();
  const platform = usePlatform();
  const [singleKeys] = useSingleKeyShortcuts();
  const admin = isAtLeastAdmin(userRole);
  const [recent] = useState(() =>
    readRecent(userId).filter((e) => admin || !isAdminPage(e.href)),
  );

  /** A page: closes, remembers it in Recent, goes. */
  const go = (entry: RecentEntry) => {
    setOpen(false);
    recordRecent(userId, entry);
    router.push(entry.href);
  };

  /** A command: closes, then runs it if it still may and can. */
  const run = (resolved: ResolvedCommand) => {
    setOpen(false);
    // Still registered and allowed (the page or the role may have changed)?
    if (!resolveCommands().includes(resolved)) return;
    runCommand(resolved);
  };

  // A key shows only where a press runs this command: its live keys (the
  // single-key switch), less any another scope takes.
  const winners = resolveKeyMap(commands);
  const row = (resolved: ResolvedCommand): CommandRow => {
    const bindings = liveBindings(resolved.command, singleKeys).filter(
      (b) => winners.get(keyIdentity(bindingKey(b))) === resolved,
    );
    return {
      resolved,
      keys: formatKeys(bindings, platform),
      ariaKeys: ariaKeyShortcuts(bindings, platform),
    };
  };

  // The page's own commands that apply now.
  const actions = commands
    .filter((c) => c.scope !== "global" && enabledNow(c))
    .map(row);
  const preferences = commands
    .filter(
      (c) =>
        c.scope === "global" &&
        preferenceRank(c.command.id) !== null &&
        enabledNow(c),
    )
    .sort(
      (a, b) =>
        (preferenceRank(a.command.id) ?? 0) -
        (preferenceRank(b.command.id) ?? 0),
    )
    .map(row);

  const commandItem = (
    prefix: string,
    { resolved, keys, ariaKeys }: CommandRow,
  ) => (
    <Item
      key={`${resolved.scope}:${resolved.command.id}`}
      value={`${prefix}:${resolved.scope}:${resolved.command.id}`}
      label={resolved.command.label}
      keys={keys}
      ariaKeys={ariaKeys}
      onSelect={() => run(resolved)}
    />
  );
  const pageItem = (prefix: string, entry: RecentEntry) => (
    <Item
      key={entry.href}
      value={`${prefix}:${entry.href}`}
      label={entry.label}
      onSelect={() => go(entry)}
    />
  );

  // No vim keys: cmdk's Ctrl+K ("previous item") would take the key off a
  // Mac, and ⌘K / Ctrl+K must close the palette.
  return (
    <Command
      label="Command palette"
      className="bg-overlay"
      vimBindings={false}
      filter={byLabel}
    >
      <Command.Input
        placeholder="Search batches and tests, or run a command…"
        className="w-full border-b border-edge px-4 py-3 text-sm outline-none bg-transparent"
        data-testid="command-input"
      />
      <Command.List className="max-h-80 overflow-auto p-1">
        <Command.Empty className="p-3 text-sm text-fg-muted">
          No results
        </Command.Empty>

        {actions.length > 0 && (
          <Command.Group heading="Actions" className={CMD_GROUP_CLASS}>
            {actions.map((r) => commandItem("action", r))}
          </Command.Group>
        )}

        <Command.Group heading="Go to" className={CMD_GROUP_CLASS}>
          {goToPages(admin, currentProjectId).map((p) => pageItem("goto", p))}
        </Command.Group>

        {recent.length > 0 && (
          <Command.Group heading="Recent" className={CMD_GROUP_CLASS}>
            {recent.map((p) => pageItem("recent", p))}
          </Command.Group>
        )}

        {/* ADR-052: no project switching for non-admins. */}
        {admin && projects.length > 0 && (
          <Command.Group heading="Projects" className={CMD_GROUP_CLASS}>
            {projects.map((p) => pageItem("project", projectJump(p)))}
          </Command.Group>
        )}

        {preferences.length > 0 && (
          <Command.Group heading="Preferences" className={CMD_GROUP_CLASS}>
            {preferences.map((r) => commandItem("pref", r))}
          </Command.Group>
        )}

        <Command.Group heading="Account" className={CMD_GROUP_CLASS}>
          {ACCOUNT_PAGES.map((p) => pageItem("account", p))}
        </Command.Group>
      </Command.List>
      <ResultCount />
    </Command>
  );
}

/**
 * The ⌘K command palette (spec §5.2). Its groups, in order: Actions (the
 * current page's commands that are enabled, with their keys), Go to, Recent
 * (per user), Projects (admins), Preferences and Account. With an empty
 * search they keep that order; while typing, cmdk ranks the matches.
 *
 * Open state lives in `usePaletteStore` (zustand), so commands can open it
 * from outside React. It has no key listener of its own: ⌘K / Ctrl+K is the
 * global `palette.open` command, run by the layout's one key dispatcher,
 * which never opens it over another dialog. `data-command-palette` marks its
 * dialog, the one where ⌘K still fires (to close it). Letters typed in its
 * search box are the search's: the dispatcher's guard owns them there.
 *
 * Commands come from the registry; the projects from the protected layout's
 * server data (`useCurrentProject`), so opening it fetches nothing.
 */
export function CommandPalette({ userRole, userId }: Props): JSX.Element {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="rounded-overlay bg-overlay shadow-overlay p-0 overflow-hidden max-w-xl"
        // The search box and the list say what it is.
        aria-describedby={undefined}
        data-testid="command-palette"
        data-command-palette=""
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <PaletteBody userRole={userRole} userId={userId} />
      </DialogContent>
    </Dialog>
  );
}
