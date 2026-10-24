/** The per-step diff numbers a `runs.listCheckpoints` item carries. */
interface StepNumbers {
  diffPercent: number | null;
  vlmDescription: string | null;
  /** 0: a row from before per-step diffs, whose numbers live on the run. */
  diffGeneration: number;
}

/**
 * A step's own diff number (spec §9), for the viewer's sidebar and lists.
 *
 * The run's `diffPercent` and `vlmDescription` are its worst step's, so for a
 * step diffed per step they are often another step's. The step's own value is
 * therefore shown alone (R46): a step with none (failed, new or still
 * diffing) has none, and reads as "no value". Only a row from before per-step
 * diffs (`diffGeneration` 0) falls back to the run's, since its numbers were
 * only ever kept there. Before the step list has loaded there is no step to
 * ask, and the run's value stands.
 *
 * `??`, not `||`: a real 0 is the step's own number, and is kept.
 */
export function stepNumber<K extends "diffPercent" | "vlmDescription">(
  step: Pick<StepNumbers, K | "diffGeneration"> | undefined,
  key: K,
  runValue: StepNumbers[K] | null | undefined,
): StepNumbers[K] | null {
  if (!step) return runValue ?? null;
  const own = step[key] ?? null;
  return step.diffGeneration === 0 ? (own ?? runValue ?? null) : own;
}
