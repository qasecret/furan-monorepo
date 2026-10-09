import { builds, eq, inArray, testRuns, type DB, type Tx } from "@furan/db";
import type {
  CheckpointDecisionKind,
  DecisionSource,
} from "@furan/shared-types";
import type { Telemetry } from "@furan/telemetry";

import type { AuthedUser } from "../../plugins/auth.js";
import type { Broadcaster } from "../broadcast.js";
import { emitAudit } from "../emit-audit.js";

import {
  decideCheckpoints,
  type DecideDeps,
  type DecideInput,
  type DecideLogger,
  type DecideResult,
} from "./decide.js";
import { reviewError } from "./errors.js";
import { GROUP_APPROVE_CAP, groupScope, loadGroupSeed } from "./groups.js";
import {
  selectPendingTargets,
  type ReviewTarget,
  type SelectionScope,
} from "./targets.js";

/**
 * What every review action shares around the decision core, whichever surface
 * calls it: the `review` router, the legacy `runs.*` / `inbox.*` wrappers and
 * the SDK's REST approve. The router or wrapper chooses WHAT to decide; these
 * helpers run the core, announce the result after commit and write the
 * build-level audit summaries.
 */

/** What a review action needs from its request (a tRPC procedure or a REST route). */
export interface ReviewActionCtx {
  /** The request transaction (ADR-058); the core runs inside it. */
  tx: Tx;
  actor: AuthedUser;
  deps: DecideDeps;
  broadcaster: Broadcaster;
  /** Registers an effect to run after the request transaction commits. */
  onCommit: (effect: () => unknown) => void;
}

/** A tRPC procedure's context (after `authed`) as a review action context. */
export function trpcActionCtx(ctx: {
  db: DB;
  user: AuthedUser;
  telemetry: Telemetry;
  broadcaster: Broadcaster;
  req: { log: DecideLogger };
  onCommit: (effect: () => unknown) => void;
}): ReviewActionCtx {
  return {
    // `ctx.db` is the request transaction (`scopeToUser`).
    tx: ctx.db as unknown as Tx,
    actor: ctx.user,
    deps: { registry: ctx.telemetry.metrics, logger: ctx.req.log },
    broadcaster: ctx.broadcaster,
    onCommit: ctx.onCommit,
  };
}

// ---------------------------------------------------------------------------
// Project resolution.
// ---------------------------------------------------------------------------

/** The project a run belongs to, or null when there is no such run. */
export async function resolveRunProject(
  db: DB | Tx,
  runId: string,
): Promise<string | null> {
  const rows = await db
    .select({ projectId: testRuns.projectId })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** The project a build belongs to, or null when there is no such build. */
export async function resolveBuildProject(
  db: DB | Tx,
  buildId: string,
): Promise<string | null> {
  const rows = await db
    .select({ projectId: builds.projectId })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/**
 * `resolveRunProject`, NOT_FOUND when there is no such run. An admin skips the
 * membership gate's resolver, so every handler resolves the project again.
 */
export async function requireRunProject(
  db: DB | Tx,
  runId: string,
): Promise<string> {
  const projectId = await resolveRunProject(db, runId);
  if (!projectId) throw reviewError("NOT_FOUND", "run_not_found");
  return projectId;
}

/** `resolveBuildProject`, NOT_FOUND when there is no such build. */
export async function requireBuildProject(
  db: DB | Tx,
  buildId: string,
): Promise<string> {
  const projectId = await resolveBuildProject(db, buildId);
  if (!projectId) throw reviewError("NOT_FOUND", "build_not_found");
  return projectId;
}

// ---------------------------------------------------------------------------
// Deciding, announcing, auditing.
// ---------------------------------------------------------------------------

/**
 * Queues the project events for the runs an action changed, to go out after
 * the request commits: `testRun_updated` for every run (in the given order)
 * and `build_updated` once per affected build. Nothing for no runs. A replay
 * announces again: the events are idempotent "refetch" hints, and the
 * original's broadcast may have been lost.
 */
export async function announceRuns(
  ctx: ReviewActionCtx,
  projectId: string,
  runIds: string[],
): Promise<void> {
  if (runIds.length === 0) return;
  const rows = await ctx.tx
    .select({ buildId: testRuns.buildId })
    .from(testRuns)
    .where(inArray(testRuns.id, runIds));
  const buildIds = [...new Set(rows.map((r) => r.buildId))].sort();
  ctx.onCommit(async () => {
    for (const id of runIds) {
      await ctx.broadcaster.publishProjectEvent(projectId, {
        event: "testRun_updated",
        data: { id },
      });
    }
    for (const id of buildIds) {
      await ctx.broadcaster.publishProjectEvent(projectId, {
        event: "build_updated",
        data: { id },
      });
    }
  });
}

/**
 * A decision result plus whether the cap cut the action short. `capped` means
 * "pending checkpoints remain: run it again to continue". On a replay (a retry
 * of an action that already ran) it is read from what is still pending now.
 */
export interface ReviewResult extends DecideResult {
  capped: boolean;
  cap: number;
}

/** What an action decides, and how its cap applied. */
export interface Selection {
  targets: ReviewTarget[];
  /** The cap cut the selection short. */
  capped: boolean;
  cap: number;
  /** Where "still pending?" is asked when this action turns out to be a replay. */
  scope?: SelectionScope;
}

/** Whether any checkpoint in `scope` is still pending (what "capped" means on a replay). */
async function anyPending(
  ctx: ReviewActionCtx,
  scope: SelectionScope,
): Promise<boolean> {
  const { preview } = await selectPendingTargets(ctx.tx, scope, 0);
  return preview.pendingCheckpoints > 0;
}

/** Runs the core for a selection, queues the broadcasts and shapes the result. */
export async function decideSelection(
  ctx: ReviewActionCtx,
  input: Omit<DecideInput, "actor" | "targets">,
  selection: Selection,
): Promise<ReviewResult> {
  const result = await decideCheckpoints(
    ctx.tx,
    { ...input, actor: ctx.actor, targets: selection.targets },
    ctx.deps,
  );
  await announceRuns(
    ctx,
    input.projectId,
    result.runs.map((r) => r.runId),
  );
  const capped = result.replayed
    ? selection.scope !== undefined && (await anyPending(ctx, selection.scope))
    : selection.capped;
  return { ...result, capped, cap: selection.cap };
}

/** How many checkpoint ids a build-level audit row lists; `count` has the total. */
const AUDIT_CHECKPOINT_IDS_CAP = 50;

/**
 * One build-level audit row for an action that spans runs (the core already
 * wrote one per run). Nothing for a replay or an action that decided nothing.
 */
export async function auditBuildAction(
  ctx: ReviewActionCtx,
  action: "run.approve_build" | "run.approve_group" | "run.reject_group",
  buildId: string,
  projectId: string,
  source: Extract<DecisionSource, "batch" | "group">,
  result: ReviewResult,
  extra: Record<string, unknown>,
): Promise<void> {
  if (result.replayed || result.decided.length === 0) return;
  await emitAudit(
    ctx.tx,
    {
      actorId: ctx.actor.id,
      action,
      targetType: "build",
      targetId: buildId,
      metadata: {
        projectId,
        actionId: result.actionId,
        source,
        checkpointIds: result.decided
          .slice(0, AUDIT_CHECKPOINT_IDS_CAP)
          .map((d) => d.checkpointId),
        count: result.decided.length,
        runIds: result.runs.map((r) => r.runId),
        capped: result.capped,
        ...extra,
      },
    },
    ctx.deps.logger,
  );
}

/**
 * Decides the pending members of `checkpointId`'s group as one action
 * (`GROUP_APPROVE_CAP`, capture order): `review.approveGroup` / `rejectGroup`
 * and the legacy `runs.approveCheckpointGroup` / `rejectCheckpointGroup`.
 *
 * The group is re-derived on the server (never a client list): the build's
 * checkpoints with the seed's diff signature, filtered by the core's own
 * pending rule, in the project resolved here (R18). A seed without a signature
 * (VLM / auto-approved / no meaningful diff) has no group; the empty selection
 * still lets the core replay a known actionId. NOT_FOUND for an unknown run or
 * checkpoint, BAD_REQUEST for a checkpoint of another run.
 */
export async function decideGroup(
  ctx: ReviewActionCtx,
  input: { runId: string; checkpointId: string; actionId: string },
  decision: CheckpointDecisionKind,
): Promise<ReviewResult> {
  const projectId = await requireRunProject(ctx.tx, input.runId);
  const seed = await loadGroupSeed(ctx.tx, input);

  const scope = groupScope(seed, projectId) ?? undefined;
  const selected = scope
    ? await selectPendingTargets(ctx.tx, scope, GROUP_APPROVE_CAP)
    : null;

  const result = await decideSelection(
    ctx,
    { projectId, actionId: input.actionId, source: "group", decision },
    {
      targets: selected?.targets ?? [],
      capped: selected?.preview.capped ?? false,
      cap: GROUP_APPROVE_CAP,
      ...(scope ? { scope } : {}),
    },
  );
  await auditBuildAction(
    ctx,
    decision === "approved" ? "run.approve_group" : "run.reject_group",
    seed.buildId,
    projectId,
    "group",
    result,
    {
      seedRunId: seed.runId,
      seedCheckpointId: seed.id,
      diffSignature: seed.diffSignature,
    },
  );
  return result;
}
