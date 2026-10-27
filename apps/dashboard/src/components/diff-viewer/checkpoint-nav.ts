/**
 * Per-checkpoint summary for a run's checkpoint list. The left checkpoint
 * rail that consumed this was removed (navigation is the batch-detail grid +
 * the diff-viewer top-bar prev/next); the type lives on for the viewer's step
 * navigation and step labels. Moving to the next pending step is the review
 * loop's (`useReviewLoop`), in the server's order. A step's own numbers are
 * its read's (`runs.getStep`), not the list's.
 */
export interface CheckpointSummary {
  id: string;
  name: string;
  /**
   * The step's review state (`CheckpointReviewState`); null while it has not
   * been diffed yet.
   */
  state: string | null;
}

/** The step-list fields the summaries are made from. */
interface SummarizedStep {
  id: string;
  name: string | null;
  state: string | null;
}

/** The summaries of a run's steps, in the server's order. */
export function summarizeCheckpoints(
  items: ReadonlyArray<SummarizedStep>,
): CheckpointSummary[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name ?? item.id,
    state: item.state,
  }));
}
