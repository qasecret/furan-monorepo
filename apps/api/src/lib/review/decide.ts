import {
  and,
  asc,
  checkpointDecisions,
  eq,
  inArray,
  recomputeRunStatus,
  testRuns,
  type NewCheckpointDecisionRow,
  type Tx,
} from "@furan/db";
import {
  decisionSnapshotSchema,
  type CheckpointDecisionKind,
  type CheckpointReviewState,
  type DecisionSnapshot,
  type DecisionSource,
  type ReviewErrorDetails,
  type RunStatus,
} from "@furan/shared-types";
import type { Registry } from "@furan/telemetry";

import type { AuthedUser } from "../../plugins/auth.js";
import { emitAudit } from "../emit-audit.js";

import { reviewError } from "./errors.js";
import { recordReviewDecisions } from "./metrics.js";
import {
  lockVariationsForPromotion,
  promoteCheckpointInTx,
  type LockedVariation,
} from "./promote.js";
import {
  assessTargets,
  dedupeTargets,
  loadActiveDecisions,
  loadWinner,
  lockRuns,
  type ReviewTarget,
  type TargetRefusal,
} from "./targets.js";

export { selectPendingTargets, type ReviewTarget } from "./targets.js";

/**
 * The decision core (spec §5.1): the one place a checkpoint is approved or
 * rejected. Every approve/reject path (viewer, batch, group, SDK, inbox)
 * calls `decideCheckpoints`, so legality, the undo snapshot, the baseline
 * promotion, the append-only decision row and the run status cannot drift.
 */

export interface DecideInput {
  actor: AuthedUser;
  projectId: string;
  /** Client-generated; groups the rows of one user action and makes retries idempotent. */
  actionId: string;
  source: DecisionSource;
  decision: CheckpointDecisionKind;
  targets: ReadonlyArray<ReviewTarget>;
  /**
   * ADR-036 reviewer-drawn ignore regions: approve, exactly one target. They
   * replace the variation's regions. There is no "clear" form: no surface
   * sends one (`review.approve` only passes a list).
   */
  ignoreAreas?: unknown[];
  /** Reject note; recorded on the audit row. */
  reason?: string;
}

export interface DecideResult {
  actionId: string;
  /** In capture order. */
  decided: Array<{
    checkpointId: string;
    runId: string;
    state: CheckpointReviewState;
  }>;
  /** Each affected run's status after the decision, in ascending run id order. */
  runs: Array<{ runId: string; status: RunStatus }>;
  /** True when `actionId` had already been applied and nothing was done. */
  replayed: boolean;
}

export interface DecideLogger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface DecideDeps {
  registry: Registry;
  logger: DecideLogger;
}

/** How many checkpoint ids an audit row lists; `count` carries the full number. */
const AUDIT_CHECKPOINT_IDS_CAP = 50;
/** At most one active decision per checkpoint (migration 0035). */
const ACTIVE_DECISION_INDEX = "checkpoint_decisions_active_uniq";
/** Rows per decision INSERT (9 bind parameters each, well under Postgres's 65535). */
const INSERT_CHUNK = 1_000;

/**
 * Approves or rejects `input.targets` inside the caller's transaction.
 *
 * 1. Locks the target runs `FOR NO KEY UPDATE`, ascending id (R8).
 * 2. Then, under those locks, replays a known `actionId` (`replayed: true`,
 *    nothing else done), so a retry racing its original cannot act twice.
 *    With no targets nothing is locked or written, but a known `actionId`
 *    still replays (a retried "all pending" selection comes back empty).
 * 3. Loads the facts (one statement) and applies legality (spec §5.4).
 *    Explicit targets are all-or-nothing: any refusal throws before the first
 *    write — `CONFLICT already_decided` (with `details.winner`) when a target
 *    is already decided, else `PRECONDITION_FAILED <first reason>`. A run
 *    outside the project is `NOT_FOUND`.
 * 4. Locks the variations (approve), ascending id, reading what the
 *    promotions start from; then, in capture order, promotes each checkpoint
 *    (snapshotting what it replaces) or records a reject, inserts the decision
 *    rows and recomputes each run's status in ascending run id order, under
 *    the run locks taken in step 1 (`lockHeld`). This write phase runs in its
 *    own savepoint (R16), so any failure after the first write leaves nothing
 *    behind even if the caller's transaction goes on to commit. A concurrent
 *    decision on the same checkpoint (unique violation) becomes `CONFLICT
 *    already_decided`.
 * 5. Writes one audit row per run, counts the decisions and logs the action.
 *
 * Every fact is read once: the runs (with their lock), the replay check and
 * the targets' facts, then each variation (with its lock).
 *
 * Broadcasting is the caller's job, after commit; `runs` names what changed.
 */
export async function decideCheckpoints(
  tx: Tx,
  input: DecideInput,
  deps: DecideDeps,
): Promise<DecideResult> {
  return (await decideCheckpointsWithBuilds(tx, input, deps)).result;
}

/**
 * {@link decideCheckpoints}, plus the build of each run it decided in, as it
 * read them when it locked the runs: a caller that announces the result
 * (`announceRuns`) needs no read of its own. Empty for a replay, or when
 * nothing was decided.
 */
export async function decideCheckpointsWithBuilds(
  tx: Tx,
  input: DecideInput,
  deps: DecideDeps,
): Promise<{
  result: DecideResult;
  buildIdByRun: ReadonlyMap<string, string>;
}> {
  const noBuilds: ReadonlyMap<string, string> = new Map();
  const { actor, projectId, actionId, source, decision } = input;
  const targets = dedupeTargets(input.targets);
  if (
    input.ignoreAreas !== undefined &&
    (decision !== "approved" || targets.length !== 1)
  ) {
    throw reviewError(
      "BAD_REQUEST",
      "ignore_areas_need_a_single_approve_target",
    );
  }
  if (targets.length === 0) {
    // Still a replay when the action was applied: a retried implicit
    // selection ("all pending", the build drain, saveNewTests) finds nothing
    // left once its original committed. Nothing is written, so no locks.
    const result = (await replayAction(tx, projectId, actionId)) ?? {
      actionId,
      decided: [],
      runs: [],
      replayed: false,
    };
    return { result, buildIdByRun: noBuilds };
  }

  // 1. Locks first (R8); 2. then idempotency, so it sees a committed original.
  // Lowercase uuid text sorts like Postgres's uuid order.
  const runIds = [...new Set(targets.map((t) => t.runId))].sort();
  const runs = await lockRuns(tx, projectId, runIds);
  const replay = await replayAction(tx, projectId, actionId);
  if (replay) return { result: replay, buildIdByRun: noBuilds };
  if (runs.size !== runIds.length) {
    throw reviewError("NOT_FOUND", "run_not_found");
  }

  // 3. Facts and legality. Refusals all happen before the first write.
  const { checkpoints: ordered, reasons } = await assessTargets(
    tx,
    runs,
    targets,
    decision,
  );
  if (reasons.length > 0) await refuse(tx, reasons);

  // The variations an approve promotes onto, locked, as each promotion
  // starts from them; a promotion's write carries forward to the next one of
  // the same variation.
  const variations: Map<string, LockedVariation> =
    decision === "approved"
      ? await lockVariationsForPromotion(
          tx,
          [...new Set(ordered.map((s) => s.testVariationId))].sort(),
        )
      : new Map();

  // 4. The write phase, atomic on its own (R16).
  let statuses: DecideResult["runs"];
  try {
    statuses = await tx.transaction(async (sp) => {
      const rows: NewCheckpointDecisionRow[] = [];
      for (const shot of ordered) {
        let before: DecisionSnapshot = { baseline: null, variation: null };
        if (decision === "approved") {
          const promoted = await promoteCheckpointInTx(
            sp,
            shot,
            variations.get(shot.testVariationId),
            runs.get(shot.runId)!,
            actor.id,
            input.ignoreAreas,
          );
          if (promoted.variationAfter) {
            variations.set(shot.testVariationId, {
              id: shot.testVariationId,
              ...promoted.variationAfter,
            });
          }
          before = decisionSnapshotSchema.parse(promoted);
        }
        rows.push({
          projectId,
          // Always the screenshot's run: loadRollupInputs keys decisions by it.
          runId: shot.runId,
          screenshotId: shot.id,
          actionId,
          decision,
          actorId: actor.id,
          source,
          before,
        });
      }
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await sp
          .insert(checkpointDecisions)
          .values(rows.slice(i, i + INSERT_CHUNK));
      }
      // Step 1 locked every run in `runIds`, in this transaction.
      const out: DecideResult["runs"] = [];
      for (const runId of runIds) {
        const { after } = await recomputeRunStatus(sp, runId, {
          lockHeld: true,
        });
        out.push({ runId, status: after });
      }
      return out;
    });
  } catch (err) {
    if (isActiveDecisionViolation(err)) await refuseLostRace(tx, ordered);
    throw err;
  }

  // 5. Audit (one row per run), metrics, log.
  const idsByRun = new Map<string, string[]>(runIds.map((id) => [id, []]));
  for (const shot of ordered) idsByRun.get(shot.runId)!.push(shot.id);
  for (const [runId, checkpointIds] of idsByRun) {
    await emitAudit(
      tx,
      {
        actorId: actor.id,
        action:
          decision === "approved"
            ? "run.approve_checkpoints"
            : "run.reject_checkpoints",
        targetType: "run",
        targetId: runId,
        metadata: {
          actionId,
          source,
          checkpointIds: checkpointIds.slice(0, AUDIT_CHECKPOINT_IDS_CAP),
          count: checkpointIds.length,
          ...(decision === "rejected" && input.reason
            ? { reason: input.reason }
            : {}),
        },
      },
      deps.logger,
    );
  }
  recordReviewDecisions(deps.registry, decision, source, ordered.length);
  deps.logger.info(
    {
      project_id: projectId,
      // T2: a single-run action carries the `run_id` tag.
      ...(runIds.length === 1 ? { run_id: runIds[0] } : { run_ids: runIds }),
      actor_id: actor.id,
      action_id: actionId,
      decision,
      source,
      count: ordered.length,
    },
    "review_decided",
  );

  return {
    result: {
      actionId,
      decided: ordered.map((s) => ({
        checkpointId: s.id,
        runId: s.runId,
        state: decision,
      })),
      runs: statuses,
      replayed: false,
    },
    buildIdByRun: new Map([...runs.values()].map((r) => [r.id, r.buildId])),
  };
}

/**
 * The stored result of an action already applied in this project, or null.
 * Rebuilt from its decision rows (in the order they were written) plus the
 * runs' current statuses.
 */
async function replayAction(
  tx: Tx,
  projectId: string,
  actionId: string,
): Promise<DecideResult | null> {
  const rows = await tx
    .select({
      screenshotId: checkpointDecisions.screenshotId,
      runId: checkpointDecisions.runId,
      decision: checkpointDecisions.decision,
    })
    .from(checkpointDecisions)
    .where(
      and(
        eq(checkpointDecisions.actionId, actionId),
        eq(checkpointDecisions.projectId, projectId),
      ),
    )
    .orderBy(asc(checkpointDecisions.createdAt), asc(checkpointDecisions.id));
  if (rows.length === 0) return null;
  const runRows = await tx
    .select({ runId: testRuns.id, status: testRuns.status })
    .from(testRuns)
    .where(inArray(testRuns.id, [...new Set(rows.map((r) => r.runId))]))
    .orderBy(asc(testRuns.id));
  return {
    actionId,
    decided: rows.map((r) => ({
      checkpointId: r.screenshotId,
      runId: r.runId,
      state: r.decision,
    })),
    runs: runRows,
    replayed: true,
  };
}

/** Throws the refusal for `reasons` (non-empty). */
async function refuse(tx: Tx, reasons: TargetRefusal[]): Promise<never> {
  const conflict = reasons.find((r) => r.reason === "already_decided");
  if (conflict) {
    const winner = await loadWinner(tx, conflict.checkpointId);
    throw reviewError(
      "CONFLICT",
      "already_decided",
      withWinner(reasons, winner),
    );
  }
  throw reviewError("PRECONDITION_FAILED", reasons[0]!.reason, { reasons });
}

/**
 * A concurrent writer decided one of our checkpoints between our legality
 * check and our insert. The savepoint is gone, so the caller's transaction is
 * usable: report every target that now has an active decision.
 */
async function refuseLostRace(
  tx: Tx,
  ordered: ReadonlyArray<{ id: string }>,
): Promise<never> {
  const active = await loadActiveDecisions(
    tx,
    ordered.map((s) => s.id),
  );
  const reasons: TargetRefusal[] = ordered
    .filter((s) => active.has(s.id))
    .map((s) => ({ checkpointId: s.id, reason: "already_decided" }));
  const winner = reasons[0]
    ? await loadWinner(tx, reasons[0].checkpointId)
    : null;
  throw reviewError("CONFLICT", "already_decided", withWinner(reasons, winner));
}

function withWinner(
  reasons: TargetRefusal[],
  winner: ReviewErrorDetails["winner"] | null,
): ReviewErrorDetails {
  return winner ? { reasons, winner } : { reasons };
}

/** A unique violation of the one-active-decision-per-checkpoint index. */
function isActiveDecisionViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as { code?: unknown; constraint_name?: unknown };
    if (e.code === "23505" && e.constraint_name === ACTIVE_DECISION_INDEX) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
