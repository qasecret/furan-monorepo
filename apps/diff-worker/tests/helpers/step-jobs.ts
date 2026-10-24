import { asc, bumpStepGenerations, eq, screenshots, type DB } from "@furan/db";

import {
  handleDiffJob,
  type DiffAttempt,
  type DiffJobOutcome,
  type HandlerDeps,
  type StepJob,
} from "../../src/handler.js";

/**
 * Queues every step of a run for a diff, as the per-step pipeline does: bumps
 * each step's version in one transaction and returns one step job per step,
 * in capture order (`created_at, id`).
 */
export async function stepJobsFor(
  db: DB,
  run: { runId: string; projectId: string },
): Promise<StepJob[]> {
  const steps = await db
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(eq(screenshots.runId, run.runId))
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
  const bumped = await db.transaction((tx) =>
    bumpStepGenerations(
      tx,
      run.runId,
      steps.map((s) => s.id),
    ),
  );
  const generationOf = new Map(bumped.map((b) => [b.id, b.generation]));
  return steps.map((s) => ({
    runId: run.runId,
    projectId: run.projectId,
    screenshotId: s.id,
    generation: generationOf.get(s.id)!,
  }));
}

/**
 * Diffs a whole run the per-step way: `stepJobsFor`, then `handleDiffJob` on
 * each step job, one after another (capture order unless `reverse`). Returns
 * each job's outcome, in the order run.
 */
export async function diffRunPerStep(
  run: { runId: string; projectId: string },
  logger: Parameters<typeof handleDiffJob>[1],
  deps: HandlerDeps,
  opts: { reverse?: boolean; attempt?: DiffAttempt } = {},
): Promise<DiffJobOutcome[]> {
  const jobs = await stepJobsFor(deps.db, run);
  if (opts.reverse) jobs.reverse();
  const outcomes: DiffJobOutcome[] = [];
  for (const job of jobs) {
    outcomes.push(await handleDiffJob(job, logger, deps, opts.attempt));
  }
  return outcomes;
}
