import type { Command, CommandCtx } from "@/lib/commands/types";
import type { ReviewStatus } from "@/lib/review-url";

/**
 * What the Batches page's commands act on: the page's live state, handed to
 * `useCommands` on every render. The page keeps the logic (its cursor, its
 * Start reviewing, its chips); a command only says when it applies and calls
 * the one the page already has.
 */
export interface BatchesCtx extends CommandCtx {
  /** The rows on screen: with none, there is nowhere to move. */
  rowCount: number;
  next(): void;
  prev(): void;
  first(): void;
  last(): void;
  /** The cursor is on a row that is on screen. */
  canOpen: boolean;
  /** Opens that row's batch, as its link does. */
  open(): void;
  /** The Start reviewing button is not disabled. */
  canStart: boolean;
  /** What the Start reviewing button does. */
  start(): Promise<void>;
  /** Focuses the search box. */
  focusSearch(): void;
  /** What a status chip does. */
  show(status: ReviewStatus): void;
}

/** The rows' container: the arrow keys and Home / End act only inside it. */
export const BATCHES_LIST = "[data-batches-list]";

const hasRows = ({ rowCount }: BatchesCtx) => rowCount > 0;

/** The chips, as palette commands: each one's status, and its label. */
const SHOW: ReadonlyArray<{ status: ReviewStatus; label: string }> = [
  { status: "needs-review", label: "Show: Needs review" },
  { status: "failed", label: "Show: Failed" },
  { status: "running", label: "Show: Running" },
  { status: "passed", label: "Show: Passed" },
  { status: "all", label: "Show: All" },
];

/**
 * Spec §4.2: the Batches page's commands, ids and labels verbatim, in the
 * order the `?` sheet lists them.
 *
 * - `j` / `k` work anywhere outside a text field (the first press focuses
 *   the first row); the arrows and Home / End only while focus is in the
 *   list, and they repeat when held.
 * - Enter opens the row only from the list, where it is the row's; on any
 *   other control it stays that control's. `o` opens the cursor's row from
 *   anywhere.
 * - `/` is the page's own, over the global one that opens the palette.
 */
export const BATCHES_COMMANDS: Command<BatchesCtx>[] = [
  {
    id: "list.next",
    label: "Next row",
    group: "Navigate",
    keys: ["j", { key: "ArrowDown", focusWithin: BATCHES_LIST, repeat: true }],
    scope: "batches",
    enabled: hasRows,
    run: ({ next }) => next(),
  },
  {
    id: "list.prev",
    label: "Previous row",
    group: "Navigate",
    keys: ["k", { key: "ArrowUp", focusWithin: BATCHES_LIST, repeat: true }],
    scope: "batches",
    enabled: hasRows,
    run: ({ prev }) => prev(),
  },
  {
    id: "list.first",
    label: "First row",
    group: "Navigate",
    keys: [{ key: "Home", focusWithin: BATCHES_LIST, repeat: true }],
    scope: "batches",
    enabled: hasRows,
    run: ({ first }) => first(),
  },
  {
    id: "list.last",
    label: "Last row",
    group: "Navigate",
    keys: [{ key: "End", focusWithin: BATCHES_LIST, repeat: true }],
    scope: "batches",
    enabled: hasRows,
    run: ({ last }) => last(),
  },
  {
    id: "batches.open",
    label: "Open batch",
    group: "Navigate",
    keys: [{ key: "Enter", focusWithin: BATCHES_LIST }, "o"],
    scope: "batches",
    enabled: ({ canOpen }) => canOpen,
    run: ({ open }) => open(),
  },
  {
    id: "batches.start",
    label: "Start reviewing",
    group: "Review",
    keys: ["s"],
    scope: "batches",
    enabled: ({ canStart }) => canStart,
    run: ({ start }) => start(),
  },
  {
    // The page's own `/`: it wins over the global one that opens the palette.
    id: "search.focus",
    label: "Search batches",
    group: "Navigate",
    keys: ["/"],
    scope: "batches",
    run: ({ focusSearch }) => focusSearch(),
  },
  ...SHOW.map(({ status, label }): Command<BatchesCtx> => ({
    id: `batches.show.${status}`,
    label,
    group: "View",
    scope: "batches",
    run: ({ show }) => show(status),
  })),
];
