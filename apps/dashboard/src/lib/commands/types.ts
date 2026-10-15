import type { ViewerRole } from "@/lib/roles";

/** The pages that register their own commands. One is mounted at a time. */
export type PageScope = "batches" | "batch" | "viewer";

/**
 * Where a command applies. On a shared key the most specific scope wins:
 * `viewer` > `batch` > `batches` > `global`.
 */
export type CommandScope = "global" | PageScope;

/** The heading a command is listed under in the `?` sheet and the palette. */
export type CommandGroup =
  | "Review"
  | "Navigate"
  | "View"
  | "Editor"
  | "Go to"
  | "Preferences"
  | "Account"
  | "Help";

/** Which key glyphs to show: ⌘ ⇧ on macOS, Ctrl Shift elsewhere. */
export type Platform = "mac" | "other";

/**
 * What every command sees when it is checked or run. A scope extends it with
 * its own live state (the current step, the focused row…); the role comes
 * from `CommandRoleProvider`.
 */
export interface CommandCtx {
  role: ViewerRole;
}

/**
 * One thing the user can do from the keyboard, the palette or a button. It is
 * defined once; the dispatcher, the `?` sheet, the palette's actions and the
 * button hints are all generated from it.
 */
export interface Command<C extends CommandCtx = CommandCtx> {
  /** Stable id, e.g. "review.approve". */
  id: string;
  /** Verbatim copy (spec §4), e.g. "Approve step". */
  label: string;
  group: CommandGroup;
  /** tinykeys syntax: "a", "$mod+k", "g i", "Shift+ArrowDown". */
  keys?: string[];
  scope: CommandScope;
  /** Role / permission. False: never bound, listed or shown. */
  allowed?: (ctx: C) => boolean;
  /** Page state. False: not run; listed in the sheet, hidden in palette actions. */
  enabled?: (ctx: C) => boolean;
  run: (ctx: C) => void | Promise<void>;
  /**
   * CSS selector of the one dialog this key may fire inside, e.g.
   * "[data-command-palette]" (⌘K closes the palette) or "[data-done-card]".
   */
  allowInDialog?: string;
  /** Selector: the key acts only while focus is inside it (list arrows, Home/End). */
  focusWithin?: string;
  /** Fires on auto-repeat (zoom, the list cursor). */
  repeat?: boolean;
  /** Shown in the viewer's floating hint bar. */
  primary?: boolean;
  /** ⌘Z: still fires inside a `[data-passes-undo]` dialog. */
  passesUndo?: boolean;
}
