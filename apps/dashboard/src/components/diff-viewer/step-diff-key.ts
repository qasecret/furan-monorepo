/**
 * The storage key of the diff image to draw for a step, and whether the step
 * should have had one it lost to history.
 *
 * Each step keeps its own diff image (`screenshots.diff_image_key`). A step
 * diffed before that column existed has none: the run's `diff_name` is its
 * WORST step's image, so it is a fair stand-in only for a run with one
 * screenshot. On a run with several, borrowing it would draw another step's
 * diff on this one, so the step gets no image and `legacyMissing` tells the
 * viewer to say so.
 *
 * - `key`: the image to fetch; null when there is none to show. With no step
 *   at all there is no wrong step to draw it on, so the run's image stands.
 * - `legacyMissing`: the step is known, has no key of its own and shares its
 *   run with others, so its image was never kept apart from the run's.
 */
export function stepDiffKey(
  step: { diffImageKey?: string | null } | null,
  run: { diffName?: string | null; screenshotCount: number },
): { key: string | null; legacyMissing: boolean } {
  const own = step?.diffImageKey ?? null;
  if (own !== null) return { key: own, legacyMissing: false };
  const legacyMissing = step !== null && run.screenshotCount > 1;
  return { key: legacyMissing ? null : (run.diffName ?? null), legacyMissing };
}
