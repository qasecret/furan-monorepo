import type { Command, CommandCtx } from "@/lib/commands/types";
import { canReviewRole } from "@/lib/roles";

/**
 * What the batch list's commands act on: the list's live state, handed to
 * `useCommands` on every render. The list keeps the logic (its cursor, its
 * rows, the step cards' own actions); a command only says when it applies
 * and calls the one the list already has.
 */
export interface BatchCtx extends CommandCtx {
  /** The items on screen (run rows and shown steps): with none, nowhere to move. */
  itemCount: number;
  next(): void;
  prev(): void;
  first(): void;
  last(): void;
  /** The cursor is on a run row with steps. */
  canExpand: boolean;
  /** Shows the row's steps; on a row showing them, goes to its first step. */
  expand(): void;
  /** The cursor is on a run row showing its steps, or on a step. */
  canCollapse: boolean;
  /** Hides the row's steps; on a step, goes to its run row. */
  collapse(): void;
  /** The cursor is on an item. */
  canOpen: boolean;
  /**
   * Opens the step in the viewer. On a run row, Enter (`key`) toggles it as
   * its own button does, and anything else (`o`, the palette) opens the run's
   * first step (R22).
   */
  open(key: string | undefined): void;
  /**
   * Read at the key press (a card's state changes without the list
   * rendering): the cursor is on a step that needs a reviewer and can be
   * decided now.
   */
  canDecide(): boolean;
  /** The step card's own Approve / Reject; the cursor goes on (spec §4.3). */
  decide(kind: "approved" | "rejected"): void;
}

/** What the batch page's own command acts on. */
export interface BatchPageCtx extends CommandCtx {
  /** The Start reviewing button can be pressed. */
  canStart: boolean;
  /** What the Start reviewing button does. */
  start(): void;
}

/** The attribute that marks the list of run rows and steps (the list sets it). */
export const BATCH_LIST_ATTR = "data-batch-list";

/** The list: the arrow keys, Home / End, Enter, `a` and `r` act only inside it. */
export const BATCH_LIST = `[${BATCH_LIST_ATTR}]`;

const hasItems = ({ itemCount }: BatchCtx) => itemCount > 0;
const mayReview = ({ role }: CommandCtx) => canReviewRole(role);

/**
 * Spec §4.3: the batch list's commands, ids and labels verbatim, in the order
 * the `?` sheet lists them (the page's Start reviewing follows).
 *
 * - `j` / `k` work anywhere outside a text field (the first press focuses
 *   the first item); the arrows and Home / End only while focus is in the
 *   list. All of them repeat when held (R23).
 * - Enter acts only from the list, where it is the item's: Enter on a run
 *   row's own button reaches the command (the button is the cursor item, and
 *   guard rule 7 exempts it), which toggles it exactly as a click would;
 *   Enter on a card's buttons stays theirs. `o` opens from anywhere.
 * - `a` and `r` decide the focused step, so only from the list.
 */
export const BATCH_COMMANDS: Command<BatchCtx>[] = [
  {
    id: "list.next",
    label: "Next item",
    group: "Navigate",
    keys: ["j", { key: "ArrowDown", focusWithin: BATCH_LIST }],
    scope: "batch",
    repeat: true,
    enabled: hasItems,
    run: ({ next }) => next(),
  },
  {
    id: "list.prev",
    label: "Previous item",
    group: "Navigate",
    keys: ["k", { key: "ArrowUp", focusWithin: BATCH_LIST }],
    scope: "batch",
    repeat: true,
    enabled: hasItems,
    run: ({ prev }) => prev(),
  },
  {
    id: "list.first",
    label: "First item",
    group: "Navigate",
    keys: [{ key: "Home", focusWithin: BATCH_LIST, repeat: true }],
    scope: "batch",
    enabled: hasItems,
    run: ({ first }) => first(),
  },
  {
    id: "list.last",
    label: "Last item",
    group: "Navigate",
    keys: [{ key: "End", focusWithin: BATCH_LIST, repeat: true }],
    scope: "batch",
    enabled: hasItems,
    run: ({ last }) => last(),
  },
  {
    id: "batch.expand",
    label: "Expand run",
    group: "View",
    keys: ["ArrowRight"],
    focusWithin: BATCH_LIST,
    scope: "batch",
    enabled: ({ canExpand }) => canExpand,
    run: ({ expand }) => expand(),
  },
  {
    id: "batch.collapse",
    label: "Collapse run",
    group: "View",
    keys: ["ArrowLeft"],
    focusWithin: BATCH_LIST,
    scope: "batch",
    enabled: ({ canCollapse }) => canCollapse,
    run: ({ collapse }) => collapse(),
  },
  {
    id: "batch.open",
    label: "Open step",
    group: "Navigate",
    keys: [{ key: "Enter", focusWithin: BATCH_LIST }, "o"],
    scope: "batch",
    enabled: ({ canOpen }) => canOpen,
    run: ({ open }, meta) => open(meta?.key),
  },
  {
    id: "batch.approve",
    label: "Approve step",
    group: "Review",
    keys: ["a"],
    focusWithin: BATCH_LIST,
    scope: "batch",
    allowed: mayReview,
    enabled: ({ canDecide }) => canDecide(),
    run: ({ decide }) => decide("approved"),
  },
  {
    id: "batch.reject",
    label: "Reject step",
    group: "Review",
    keys: ["r"],
    focusWithin: BATCH_LIST,
    scope: "batch",
    allowed: mayReview,
    enabled: ({ canDecide }) => canDecide(),
    run: ({ decide }) => decide("rejected"),
  },
];

/** The batch page's own: what its Start reviewing button does (spec §4.3). */
export const BATCH_PAGE_COMMANDS: Command<BatchPageCtx>[] = [
  {
    id: "batch.start",
    label: "Start reviewing",
    group: "Review",
    keys: ["s"],
    scope: "batch",
    allowed: mayReview,
    enabled: ({ canStart }) => canStart,
    run: ({ start }) => start(),
  },
];
