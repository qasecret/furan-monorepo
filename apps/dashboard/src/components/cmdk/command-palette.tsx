"use client";

import { Command, defaultFilter, useCommandState } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type JSX } from "react";

import {
  forgetLegacyRecent,
  readRecent,
  recordRecent,
  type RecentEntry,
} from "./palette-recent";
import { usePaletteStore } from "./use-command-palette";
import { usePaletteChoice } from "./use-palette-choice";
import {
  batchRowLabel,
  usePaletteSearch,
  type BatchHit,
  type TestHit,
} from "./use-palette-search";

import {
  useCurrentProject,
  type ProjectListItem,
} from "@/app/(protected)/_components/current-project-provider";
import { KeyChoices } from "@/components/shortcuts/key-caps";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ariaKeyShortcuts, formatKeys } from "@/lib/commands/keys";
import { usePlatform } from "@/lib/commands/platform";
import { useSingleKeyShortcuts } from "@/lib/commands/prefs";
import {
  commandLabel,
  resolveCommands,
  resolveKeyMap,
  useRegisteredCommands,
  winningBindings,
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

/**
 * The global commands that are also the current page's actions: undo has no
 * other way in than a toast or a chip, so the palette offers it (R16).
 */
const GLOBAL_ACTIONS = new Set(["review.undo"]);

/** The count is announced once typing has settled, not on every key. */
const ANNOUNCE_DELAY_MS = 300;

/** What a failed search says, on its row and to the live region (spec §8). */
const SEARCH_ERROR = {
  batches: "Couldn't search batches",
  tests: "Couldn't search tests",
} as const;

/**
 * A page the palette goes to: its id (what Recent keeps), its name, and
 * where it is now.
 */
interface Destination {
  id: string;
  label: string;
  href: string;
}

const BATCHES: Destination = {
  id: "go.batches",
  label: "Batches",
  href: "/inbox",
};

const ANALYTICS: Destination = {
  id: "go.analytics",
  label: "Analytics",
  href: "/analytics",
};

/** The admin pages in Go to, by their human names (spec §5.2). */
const ADMIN_PAGES: Destination[] = [
  { id: "admin.members", label: "Members", href: "/admin/members" },
  { id: "admin.projects", label: "Projects", href: "/admin/projects" },
  {
    id: "admin.installations",
    label: "Installations",
    href: "/admin/installations",
  },
  { id: "admin.apiKeys", label: "API keys", href: "/admin/api-keys" },
  { id: "admin.autoRules", label: "Auto rules", href: "/admin/auto-rules" },
  { id: "admin.auditLog", label: "Audit log", href: "/admin/audit-log" },
];

const ACCOUNT_PAGES: Destination[] = [
  { id: "account.tokens", label: "API tokens", href: "/account/tokens" },
];

/** The current project's settings: one id, wherever that project is. */
function settingsOf(projectId: string): Destination {
  return {
    id: "go.settings",
    label: "Settings",
    href: `/projects/${projectId}/settings`,
  };
}

/** "Jump to project: ‹name›": the project's batches (ADR-052: admins only). */
function projectJump({ id, name }: ProjectListItem): Destination {
  return {
    id: `project:${id}`,
    label: `Jump to project: ${name}`,
    href: `/projects/${id}/builds`,
  };
}

/**
 * True when `href` is the page on screen: the same path and query as the
 * address bar's (the hash is not a page).
 */
function isCurrentPage(href: string): boolean {
  if (typeof window === "undefined") return false;
  const here = window.location;
  const there = new URL(href, here.href);
  return there.pathname === here.pathname && there.search === here.search;
}

/**
 * Go to: Batches, Analytics (admins), the current project's Settings, then
 * the admin pages (admins).
 */
function goToPages(
  admin: boolean,
  currentProjectId: string | null,
): Destination[] {
  return [
    BATCHES,
    ...(admin ? [ANALYTICS] : []),
    ...(currentProjectId ? [settingsOf(currentProjectId)] : []),
    ...(admin ? ADMIN_PAGES : []),
  ];
}

/**
 * Recent as it can be offered now. One of the palette's pages (kept by id)
 * is listed as it is now, its address and name current, or left out when it
 * isn't offered to this user any more: an admin page after a demotion,
 * Settings with no current project, a project no longer listed. A page kept
 * by its address is left out of a non-admin's list when it is an admin page.
 */
function shownRecent(
  stored: RecentEntry[],
  offered: Map<string, Destination>,
  admin: boolean,
): Destination[] {
  return stored.flatMap((entry): Destination[] => {
    if (entry.href === undefined) {
      const page = offered.get(entry.id);
      return page ? [page] : [];
    }
    if (!admin && entry.href.startsWith("/admin")) return [];
    return [{ id: entry.id, label: entry.label, href: entry.href }];
  });
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
 * A search result's value starts with this (see `foundValue`): the batch or
 * test is there because the server (or the Batches rule) matched it, so
 * cmdk's own matcher must not hide it. The label can fail that matcher: the
 * typed text is trimmed before it is asked, and the server's match is a SQL
 * ILIKE, where `_` and `%` stand for any characters.
 */
const FOUND_PREFIX = "found:";

/**
 * Every result scores the same, so the rows keep the order they came in
 * (newest first) instead of being ranked by their labels.
 */
const FOUND_SCORE = 1;

function foundValue(kind: "batch" | "test", id: string): string {
  return `${FOUND_PREFIX}${kind}:${id}`;
}

/**
 * Matches what an item reads, its label (its only keyword), never its value:
 * a value is the item's unique id ("goto:admin.members"), so that Recent's
 * "Members" and Go to's are two items. A search result is the exception: it
 * is never left out, whatever it reads.
 */
function byLabel(value: string, search: string, keywords?: string[]): number {
  if (value.startsWith(FOUND_PREFIX)) return FOUND_SCORE;
  return defaultFilter(keywords?.join(" ") ?? "", search);
}

function resultCount(count: number): string {
  if (count === 0) return "No results";
  return count === 1 ? "1 result" : `${count} results`;
}

/**
 * The polite live region: "1 result" / "‹N› results" for what the typed
 * search shows (cmdk's filtered count), said once the typing has settled.
 * When nothing matched and a search failed, it says what failed instead
 * ("Couldn't search batches. Couldn't search tests"), as "No results" would
 * be only half the story. Quiet until something is typed, and again when
 * the search is cleared, and quiet while the search of batches and tests is
 * still out: the count is not final until it is answered.
 */
function ResultCount({
  pending,
  failures,
}: {
  pending: boolean;
  /** What the failed searches say, joined; empty when none failed. */
  failures: string;
}): JSX.Element {
  const search = useCommandState((s) => s.search);
  const count = useCommandState((s) => s.filtered.count);
  const [settled, setSettled] = useState<{
    search: string;
    text: string;
  } | null>(null);
  useEffect(() => {
    if (pending) return;
    const text = count === 0 && failures !== "" ? failures : resultCount(count);
    const timer = setTimeout(
      () => setSettled({ search, text }),
      ANNOUNCE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [search, count, pending, failures]);
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
      {keys.length > 0 && (
        // Hidden from assistive technology: `aria-keyshortcuts` says it.
        <span
          aria-hidden="true"
          className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs"
        >
          <KeyChoices keys={keys.map((tokens) => ({ tokens }))} />
        </span>
      )}
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
 * empty. A picked command goes to `onPick`, which runs it once the palette
 * has closed.
 */
function PaletteBody({
  userRole,
  userId,
  onPick,
  onNavigate,
}: Props & {
  onPick: (resolved: ResolvedCommand) => void;
  /** A page was picked: the palette is going to it. */
  onNavigate: () => void;
}): JSX.Element {
  const router = useRouter();
  const setOpen = usePaletteStore((s) => s.setOpen);
  const { currentProjectId, projects } = useCurrentProject();
  const [search, setSearch] = useState("");
  const found = usePaletteSearch(currentProjectId, search);
  const commands = useRegisteredCommands();
  const platform = usePlatform();
  const [singleKeys] = useSingleKeyShortcuts();
  const [stored] = useState(() => readRecent(userId));
  const admin = isAtLeastAdmin(userRole);

  const goTo = goToPages(admin, currentProjectId);
  // ADR-052: no project switching for non-admins.
  const jumps = admin ? projects.map(projectJump) : [];
  const offered = new Map(
    [...goTo, ...jumps, ...ACCOUNT_PAGES].map((page) => [page.id, page]),
  );
  const recent = shownRecent(stored, offered, admin);

  /**
   * A page: closes, remembers it in Recent (one of the palette's own by its
   * id, any other by its address too), goes. Going needs no focus, so it
   * doesn't wait for the close. The page on screen is no navigation: nothing
   * is pushed, and focus goes back to the opener as on any close (WCAG
   * 2.4.3, R36). Pushing it would only fetch the same page again, and the
   * router's own focus move after a navigation would race that restore.
   */
  const go = (page: Destination) => {
    const here = isCurrentPage(page.href);
    if (!here) onNavigate();
    setOpen(false);
    recordRecent(
      userId,
      offered.has(page.id) ? { id: page.id, label: page.label } : page,
    );
    if (!here) router.push(page.href);
  };

  // A key shows only where a press runs this command now: its live keys
  // (the single-key switch), less any another scope takes.
  const winners = resolveKeyMap(commands);
  const row = (resolved: ResolvedCommand): CommandRow => {
    const bindings = winningBindings(resolved, winners, singleKeys);
    return {
      resolved,
      keys: formatKeys(bindings, platform),
      ariaKeys: ariaKeyShortcuts(bindings, platform),
    };
  };

  // The page's own commands that apply now, then the global ones that are
  // actions too (undo, when there is something to take back). Undo comes
  // last: Enter on a fresh palette must never take back a decision.
  const actions = [
    ...commands.filter(
      (c) =>
        c.scope !== "global" && c.command.palette !== false && enabledNow(c),
    ),
    ...commands.filter(
      (c) =>
        c.scope === "global" &&
        GLOBAL_ACTIONS.has(c.command.id) &&
        enabledNow(c),
    ),
  ].map(row);
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

  // What Enter chooses on a fresh palette, and again once the search is
  // cleared: the page's first own action, else Go to Batches. Never undo,
  // which would take back a decision at a ⌘K then Enter. (cmdk's own choice
  // is the first row, which is undo on a page with no actions of its own.)
  // The choice is only where it starts: undo stays one arrow key, or a
  // search, away.
  const [startsOn] = useState(() => {
    const first = actions.find(
      (a) => !GLOBAL_ACTIONS.has(a.resolved.command.id),
    );
    return first
      ? `action:${first.resolved.scope}:${first.resolved.command.id}`
      : `goto:${BATCHES.id}`;
  });
  const { rootRef, textChanged, commandProps } = usePaletteChoice({
    startsOn,
    search,
    pending: found.pending,
    rowCount: found.batches.items.length + found.tests.items.length,
  });
  const failures = [
    found.batches.error && SEARCH_ERROR.batches,
    found.tests.error && SEARCH_ERROR.tests,
  ]
    .filter(Boolean)
    .join(". ");

  const commandItem = (
    prefix: string,
    { resolved, keys, ariaKeys }: CommandRow,
  ) => (
    <Item
      key={`${resolved.scope}:${resolved.command.id}`}
      value={`${prefix}:${resolved.scope}:${resolved.command.id}`}
      // As things stand ("Hide details" or "Show details"): the body mounts
      // each time the palette opens.
      label={commandLabel(resolved)}
      keys={keys}
      ariaKeys={ariaKeys}
      onSelect={() => onPick(resolved)}
    />
  );
  const pageItem = (prefix: string, page: Destination) => (
    <Item
      key={page.id}
      value={`${prefix}:${page.id}`}
      label={page.label}
      onSelect={() => go(page)}
    />
  );

  // A batch or test the search found. It is kept in Recent by an id the
  // palette does not own (so by its address too), under its name.
  const foundItem = (
    kind: "batch" | "test",
    hit: BatchHit | TestHit,
    label: string,
  ) => {
    const page: Destination = {
      id: `${kind}:${hit.projectId}:${hit.id}`,
      label: hit.name,
      href: hit.href,
    };
    return (
      <Item
        key={page.id}
        value={foundValue(kind, hit.id)}
        label={label}
        onSelect={() => go(page)}
      />
    );
  };
  // A search that failed is one row saying so, not a result: it is shown
  // whatever cmdk's matcher makes of the text, is not counted, and is not
  // chosen. Its group is mounted by force (`forceMount` on the group, which
  // cmdk applies to the group's items), as nothing in it is counted.
  const searchError = (what: "batches" | "tests") => (
    <Command.Item
      disabled
      value={`${FOUND_PREFIX}error:${what}`}
      className="flex items-center px-2 py-1.5 text-sm text-fg-muted"
    >
      <span className="min-w-0 truncate">{SEARCH_ERROR[what]}</span>
    </Command.Item>
  );

  // No vim keys: cmdk's Ctrl+K ("previous item") would take the key off a
  // Mac, and ⌘K / Ctrl+K must close the palette.
  return (
    <Command
      ref={rootRef}
      label="Command palette"
      className="bg-overlay"
      vimBindings={false}
      filter={byLabel}
      {...commandProps}
    >
      <Command.Input
        onValueChange={(text) => {
          textChanged();
          setSearch(text);
        }}
        placeholder="Search batches and tests, or run a command…"
        className="w-full border-b border-edge px-4 py-3 text-sm outline-none bg-transparent"
        data-testid="command-input"
      />
      <Command.List className="max-h-80 overflow-auto p-1">
        {/* Not while batches and tests are still being searched for, nor
            over the row that says a search failed. */}
        {!found.pending && failures === "" && (
          <Command.Empty className="p-3 text-sm text-fg-muted">
            No results
          </Command.Empty>
        )}

        {actions.length > 0 && (
          <Command.Group heading="Actions" className={CMD_GROUP_CLASS}>
            {actions.map((r) => commandItem("action", r))}
          </Command.Group>
        )}

        {(found.batches.items.length > 0 || found.batches.error) && (
          <Command.Group
            heading="Batches"
            forceMount={found.batches.error}
            className={CMD_GROUP_CLASS}
          >
            {found.batches.error
              ? searchError("batches")
              : found.batches.items.map((hit) =>
                  foundItem("batch", hit, batchRowLabel(hit)),
                )}
          </Command.Group>
        )}

        {(found.tests.items.length > 0 || found.tests.error) && (
          <Command.Group
            heading="Tests"
            forceMount={found.tests.error}
            className={CMD_GROUP_CLASS}
          >
            {found.tests.error
              ? searchError("tests")
              : found.tests.items.map((hit) =>
                  foundItem("test", hit, hit.name),
                )}
          </Command.Group>
        )}

        <Command.Group heading="Go to" className={CMD_GROUP_CLASS}>
          {goTo.map((p) => pageItem("goto", p))}
        </Command.Group>

        {recent.length > 0 && (
          <Command.Group heading="Recent" className={CMD_GROUP_CLASS}>
            {recent.map((p) => pageItem("recent", p))}
          </Command.Group>
        )}

        {jumps.length > 0 && (
          <Command.Group heading="Projects" className={CMD_GROUP_CLASS}>
            {jumps.map((p) => pageItem("project", p))}
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
      <ResultCount pending={found.pending} failures={failures} />
    </Command>
  );
}

/**
 * The ⌘K command palette (spec §5.2). Its groups, in order: Actions (the
 * current page's commands that are enabled, with their keys), Batches and
 * Tests (what a search of 2 or more characters finds), Go to, Recent (per
 * user), Projects (admins), Preferences and Account. Empty groups are left
 * out, and the order holds while typing: cmdk ranks the items within a group
 * and hides those that don't match, but does not move groups.
 *
 * Batches and Tests come from `usePaletteSearch`. They are never hidden by
 * cmdk's matcher (see `byLabel`); a failed search is one row in its group
 * (`searchError`) and the rest of the palette works as it does.
 *
 * Open state lives in `usePaletteStore` (zustand), so commands can open it
 * from outside React. It has no key listener of its own: ⌘K / Ctrl+K is the
 * global `palette.open` command, run by the layout's one key dispatcher,
 * which never opens it over another dialog. `data-command-palette` marks its
 * dialog, the one where ⌘K still fires (to close it). Letters typed in its
 * search box are the search's: the dispatcher's guard owns them there.
 *
 * Focus: on close it goes back to where it was when the palette opened,
 * without scrolling, unless another page was picked: that page may focus
 * something of its own, and the opener is on the page being left. (A pick
 * of the page on screen goes nowhere, so focus goes back, R36.) A picked command
 * runs only then, once the palette has let go of focus (its focus trap would
 * pull a `.focus()` back), so a command that moves focus (to a search box, a
 * list row) keeps it. It is checked again then: still registered, allowed
 * and enabled.
 *
 * Commands come from the registry; the projects from the protected layout's
 * server data (`useCurrentProject`), so opening it fetches nothing.
 */
export function CommandPalette({ userRole, userId }: Props): JSX.Element {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  /** The command picked, to run once the palette has closed. */
  const picked = useRef<ResolvedCommand | null>(null);
  /** What had focus when the palette opened. */
  const opener = useRef<HTMLElement | null>(null);
  /** A page was picked: the palette is going to it. */
  const navigating = useRef(false);

  // The un-keyed list an earlier palette kept: gone from this browser.
  useEffect(() => forgetLegacyRecent(), []);

  // Opened again before the last close finished: that pick never runs late.
  useEffect(() => {
    if (open) picked.current = null;
  }, [open]);

  const pick = (resolved: ResolvedCommand) => {
    picked.current = resolved;
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="rounded-overlay bg-overlay shadow-overlay p-0 overflow-hidden max-w-xl"
        // The search box and the list say what it is.
        aria-describedby={undefined}
        data-testid="command-palette"
        data-command-palette=""
        onOpenAutoFocus={() => {
          const focused = document.activeElement;
          opener.current = focused instanceof HTMLElement ? focused : null;
        }}
        onCloseAutoFocus={(e) => {
          // Radix would focus the dialog's trigger, and the palette has none.
          e.preventDefault();
          const back = opener.current;
          opener.current = null;
          // Going to a page: it may focus something of its own, and the
          // opener is on the page being left. Otherwise focus goes back
          // where it was, without scrolling the page to it.
          const leaving = navigating.current;
          navigating.current = false;
          if (!leaving && back?.isConnected)
            back.focus({ preventScroll: true });
          const resolved = picked.current;
          picked.current = null;
          // Checked as it runs, not as it was picked: the page or the role
          // may have changed in between.
          if (resolved && resolveCommands().includes(resolved)) {
            runCommand(resolved);
          }
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <PaletteBody
          userRole={userRole}
          userId={userId}
          onPick={pick}
          onNavigate={() => {
            navigating.current = true;
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
