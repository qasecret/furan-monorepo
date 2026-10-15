/**
 * Per-checkpoint summary for a run's checkpoint list. The left checkpoint
 * rail that consumed this was removed (navigation is the batch-detail grid +
 * the diff-viewer top-bar prev/next); the type lives on for the viewer's step
 * navigation and step labels. Moving to the next pending step is the review
 * loop's (`useReviewLoop`), in the server's order.
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
