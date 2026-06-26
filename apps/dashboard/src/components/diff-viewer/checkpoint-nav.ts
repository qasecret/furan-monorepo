import type { RunStatus } from "@furan/shared-types";

/**
 * Per-checkpoint summary for a run's checkpoint list. The left checkpoint
 * rail that consumed this was removed (navigation is the batch-detail grid +
 * the diff-viewer top-bar prev/next); the type lives on for the viewer's step
 * navigation, status auto-advance, and step labels.
 */
export interface CheckpointSummary {
  id: string;
  name: string;
  status: RunStatus;
  diffPercent: number | null;
  thumbnailUrl?: string;
  testVariationId?: string | null;
}

/**
 * The next checkpoint AFTER `currentId` whose status still needs review
 * (`"unresolved"`), or null if none remain (forward-only; no wrap). Powers
 * the post-approve/reject auto-advance triage loop.
 */
export function nextUnresolvedCheckpointId(
  summaries: { id: string; status: string }[],
  currentId: string,
): string | null {
  const idx = summaries.findIndex((c) => c.id === currentId);
  if (idx === -1) return null;
  for (let i = idx + 1; i < summaries.length; i++) {
    if (summaries[i]!.status === "unresolved") return summaries[i]!.id;
  }
  return null;
}
