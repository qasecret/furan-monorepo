/**
 * Single source of truth for how a build's aggregate status is presented in the
 * list surfaces — the batch-history panel (build-list-item) and the inbox
 * Batches table both render from this, so the two surfaces stay identical:
 * a status word, its text colour, and the row's left-accent border colour.
 */
export interface BuildStatusMeta {
  word: string;
  /** Text-colour classes for the status word (history-panel + result rows). */
  text: string;
  /** `border-l-*` colour classes for the history-panel row accent. */
  border: string;
  /** Tinted-pill classes for the Batches table (bg + text + border). */
  pill: string;
  /** `bg-*` colour for the status dot / left accent bar (result rows, cards). */
  dot: string;
}

export const BUILD_STATUS_META: Record<string, BuildStatusMeta> = {
  passed: {
    word: "Passed",
    text: "text-emerald-600 dark:text-emerald-400",
    border: "border-l-emerald-500",
    pill: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  unresolved: {
    word: "Unresolved",
    text: "text-amber-600 dark:text-amber-400",
    border: "border-l-amber-500",
    pill: "bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  failed: {
    word: "Failed",
    text: "text-red-600 dark:text-red-400",
    border: "border-l-red-500",
    pill: "bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400",
    dot: "bg-red-500",
  },
  running: {
    word: "Running",
    text: "text-blue-600 dark:text-blue-400",
    border: "border-l-blue-500",
    pill: "bg-blue-500/10 text-blue-700 border-blue-500/20 dark:text-blue-400",
    dot: "bg-blue-500",
  },
  aborted: {
    word: "Aborted",
    text: "text-zinc-500 dark:text-zinc-400",
    border: "border-l-zinc-400 dark:border-l-zinc-600",
    pill: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400",
    dot: "bg-zinc-400 dark:bg-zinc-600",
  },
  empty: {
    word: "Empty",
    text: "text-zinc-500 dark:text-zinc-400",
    border: "border-l-zinc-300 dark:border-l-zinc-700",
    pill: "bg-zinc-500/10 text-zinc-600 border-zinc-500/20 dark:text-zinc-400",
    dot: "bg-zinc-300 dark:bg-zinc-700",
  },
};

export function buildStatusMeta(status: string): BuildStatusMeta {
  return BUILD_STATUS_META[status] ?? BUILD_STATUS_META.empty!;
}
