/**
 * Per-checkpoint summary for a run's checkpoint list. The left checkpoint
 * rail that consumed this was removed (navigation is the batch-detail grid +
 * the diff-viewer top-bar prev/next); the type lives on for the viewer's step
 * navigation, auto-advance, and step labels.
 */
export interface CheckpointSummary {
  id: string;
  name: string;
  /**
   * The step's review state (`CheckpointReviewState`); null while it has not
   * been diffed yet.
   */
  state: string | null;
  diffPercent: number | null;
  thumbnailUrl?: string;
  testVariationId?: string | null;
}

/**
 * The next step after `currentId` that still needs a reviewer (`new` or
 * `unresolved`), walking forward and wrapping to the start of the run, or null
 * when no other step does. It never returns `currentId` itself, so the
 * post-decision auto-advance stays put when this was the last one.
 */
export function nextPendingCheckpointId(
  summaries: Array<{ id: string; state: string | null }>,
  currentId: string,
): string | null {
  const idx = summaries.findIndex((c) => c.id === currentId);
  if (idx === -1) return null;
  for (let step = 1; step < summaries.length; step++) {
    const candidate = summaries[(idx + step) % summaries.length]!;
    if (candidate.state === "new" || candidate.state === "unresolved") {
      return candidate.id;
    }
  }
  return null;
}
