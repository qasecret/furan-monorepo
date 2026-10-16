"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";

import { setSingleKeys, singleKeysOn } from "./prefs";
import { useCommands } from "./registry";
import type { Command, CommandCtx } from "./types";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { useTourOptional } from "@/components/tour/tour-context";
import { useReviewMutations } from "@/lib/review/use-review-mutations";
import { useUndoStore } from "@/lib/review/use-undo-store";
import { canReviewRole, isAtLeastAdmin } from "@/lib/roles";

/** What the global commands read when they run: the layout's live state. */
interface GlobalCtx extends CommandCtx {
  push(href: string): void;
  /** Takes back the newest review action of this session. */
  undo(): void;
  /** The theme on screen ("light" / "dark"), "system" resolved. */
  resolvedTheme: string | undefined;
  setTheme(theme: string): void;
  /** Null outside a TourProvider. */
  tour: ReturnType<typeof useTourOptional>;
}

const adminOnly = ({ role }: CommandCtx) => isAtLeastAdmin(role);

function openPalette(): void {
  usePaletteStore.getState().setOpen(true);
}

/** Spec §4.1: the commands of every protected page. Static, as registered. */
const GLOBAL_COMMANDS: Command<GlobalCtx>[] = [
  {
    id: "palette.open",
    label: "Open command palette",
    group: "Navigate",
    keys: ["$mod+k"],
    scope: "global",
    // Open, it closes: its own search box has focus there.
    run: () => usePaletteStore.getState().toggle(),
    allowInDialog: "[data-command-palette]",
    // From a page's text field too (the Batches search); never over another
    // dialog or menu.
    allowInText: true,
  },
  {
    id: "help.shortcuts",
    label: "Keyboard shortcuts",
    group: "Help",
    keys: ["?"],
    scope: "global",
    run: () => useShortcutsSheet.getState().setOpen(true),
  },
  {
    // A page with a search box registers its own `search.focus`, which wins.
    id: "search.focus",
    label: "Search",
    group: "Navigate",
    keys: ["/"],
    scope: "global",
    run: openPalette,
  },
  {
    id: "review.undo",
    label: "Undo last review action",
    group: "Review",
    keys: ["$mod+z"],
    scope: "global",
    // In the viewer's hint bar (spec §4.4), with the viewer's own keys.
    primary: true,
    // It takes back a review decision: a role that can't review has none.
    allowed: ({ role }) => canReviewRole(role),
    // Only while this session has an action to take back: the palette lists
    // it then, and the `?` sheet shows it as not available otherwise.
    enabled: () => useUndoStore.getState().stack.length > 0,
    // The newest action: no id. Not `allowInText`: in a field, ⌘Z is the
    // field's own undo.
    run: ({ undo }) => undo(),
    passesUndo: true,
  },
  {
    id: "go.batches",
    label: "Go to Batches",
    group: "Go to",
    keys: ["g i"],
    scope: "global",
    run: ({ push }) => push("/inbox"),
  },
  {
    id: "go.analytics",
    label: "Go to Analytics",
    group: "Go to",
    keys: ["g a"],
    scope: "global",
    allowed: adminOnly,
    run: ({ push }) => push("/analytics"),
  },
  {
    // The admin projects hub (`/projects` sends an admin there).
    id: "go.projects",
    label: "Go to Projects",
    group: "Go to",
    keys: ["g p"],
    scope: "global",
    allowed: adminOnly,
    run: ({ push }) => push("/projects"),
  },
  {
    id: "pref.theme",
    label: "Toggle theme",
    group: "Preferences",
    scope: "global",
    run: ({ resolvedTheme, setTheme }) =>
      setTheme(resolvedTheme === "dark" ? "light" : "dark"),
  },
  {
    // One of these two is enabled at a time, so the palette offers the one
    // that applies.
    id: "pref.singleKeysOff",
    label: "Turn single-key shortcuts off",
    group: "Preferences",
    scope: "global",
    enabled: () => singleKeysOn(),
    run: () => setSingleKeys(false),
  },
  {
    id: "pref.singleKeysOn",
    label: "Turn single-key shortcuts on",
    group: "Preferences",
    scope: "global",
    enabled: () => !singleKeysOn(),
    run: () => setSingleKeys(true),
  },
  {
    id: "help.tour",
    label: "Replay tour",
    group: "Help",
    scope: "global",
    enabled: ({ tour }) => Boolean(tour?.state.pageId),
    run: ({ tour }) => tour?.relaunch(),
  },
];

/**
 * Registers the commands of every protected page (spec §4.1). Mounted once,
 * in the protected layout, inside the providers they read: the router, the
 * theme, the review mutations and the tour.
 */
export function GlobalCommands(): null {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { undo } = useReviewMutations();
  const tour = useTourOptional();
  useCommands<GlobalCtx>("global", GLOBAL_COMMANDS, {
    push: (href) => router.push(href),
    undo: () => undo(),
    resolvedTheme,
    setTheme,
    tour,
  });
  return null;
}
