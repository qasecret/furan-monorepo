/**
 * Single source of truth for how a build's aggregate status is presented in the
 * list surfaces — the batch-history panel (build-list-item) and the inbox
 * Batches table both render from this, so the two surfaces stay identical:
 * a status word, its text colour, and the row's left-accent border colour.
 */
export interface BuildStatusMeta {
  word: string;
  /** Text-colour classes for the status word. */
  text: string;
  /** `border-l-*` colour classes for the row's status accent. */
  border: string;
}

export const BUILD_STATUS_META: Record<string, BuildStatusMeta> = {
  passed: {
    word: "Passed",
    text: "text-emerald-600 dark:text-emerald-400",
    border: "border-l-emerald-500",
  },
  unresolved: {
    word: "Unresolved",
    text: "text-amber-600 dark:text-amber-400",
    border: "border-l-amber-500",
  },
  failed: {
    word: "Failed",
    text: "text-red-600 dark:text-red-400",
    border: "border-l-red-500",
  },
  running: {
    word: "Running",
    text: "text-blue-600 dark:text-blue-400",
    border: "border-l-blue-500",
  },
  aborted: {
    word: "Aborted",
    text: "text-zinc-500 dark:text-zinc-400",
    border: "border-l-zinc-400 dark:border-l-zinc-600",
  },
  empty: {
    word: "Empty",
    text: "text-zinc-500 dark:text-zinc-400",
    border: "border-l-zinc-300 dark:border-l-zinc-700",
  },
};

export function buildStatusMeta(status: string): BuildStatusMeta {
  return BUILD_STATUS_META[status] ?? BUILD_STATUS_META.empty!;
}
