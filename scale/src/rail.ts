/**
 * The diff viewer's rail: a run's steps in `runs.listCheckpoints`' order.
 * Shared by the seed, which records the neighbours of the step R4 opens, and
 * the server suite, which opens any step, so neither imports the other.
 */

/**
 * The steps the viewer fetches ahead of `checkpointId`: the next one in the
 * rail, then the previous one, those that exist (`DiffViewer.tsx`'s
 * `usePrefetchSteps(runId, [nextStepId, prevStepId])`). None for a step the
 * rail does not hold.
 */
export function railNeighbours(
  rail: readonly string[],
  checkpointId: string,
): string[] {
  const at = rail.indexOf(checkpointId);
  if (at < 0) return [];
  return [rail[at + 1], rail[at - 1]].filter(
    (id): id is string => id !== undefined,
  );
}
