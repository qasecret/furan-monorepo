import {
  builds,
  checkpointDecisions,
  inArray,
  sql,
  testRuns,
  type DB,
  type SQL,
  type Tx,
} from "@furan/db";
import type {
  CheckpointDecisionKind,
  DecisionSource,
} from "@furan/shared-types";
import type { Telemetry } from "@furan/telemetry";

import type { AuthedUser } from "../../plugins/auth.js";
import type { Broadcaster } from "../broadcast.js";
import { emitAudit } from "../emit-audit.js";

import {
  decideCheckpointsWithBuilds,
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
 * calls it: the `review` router, the `inbox.*` wrappers and the SDK's REST
 * approve. The router or wrapper chooses WHAT to decide; these
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

/**
 * The lookups of the project a run, a build or a review action belongs to:
 * one column (`project_id`), at most one row, none when there is no such
 * resource. The membership gate runs them inside its own statement
 * (`projectMember`'s `lookup`, through `runLookup` and its siblings below, or
 * its `query`; spec 2026-10-27 §7), and `resolve*Project` run the same ones on
 * their own, so the gate and a handler can never disagree on what exists.
 */
export function runProjectQuery(runId: string): SQL {
  return sql`SELECT ${testRuns.projectId} FROM ${testRuns}
    WHERE ${testRuns.id} = ${runId} LIMIT 1`;
}

/** {@link runProjectQuery} for a build. */
export function buildProjectQuery(buildId: string): SQL {
  return sql`SELECT ${builds.projectId} FROM ${builds}
    WHERE ${builds.id} = ${buildId} LIMIT 1`;
}

/**
 * {@link runProjectQuery} for a review action. An action id is unique per
 * project, not globally (the client generates it), so one that appears in two
 * projects resolves, deterministically, to the project of its oldest decision
 * (`created_at, id`): `review.revert` then acts there and only there.
 */
export function actionProjectQuery(actionId: string): SQL {
  return sql`SELECT ${checkpointDecisions.projectId} FROM ${checkpointDecisions}
    WHERE ${checkpointDecisions.actionId} = ${actionId}
    ORDER BY ${checkpointDecisions.createdAt} ASC, ${checkpointDecisions.id} ASC
    LIMIT 1`;
}

/** The resources whose project the membership gate resolves for a handler. */
export type GatedKind = "run" | "build" | "action";

/**
 * A lookup for the membership gate (`projectMember`'s `from: { lookup }`):
 * the resource it is about, and the select of its project (`*ProjectQuery`).
 */
export interface GateLookup {
  kind: GatedKind;
  id: string;
  query: SQL;
}

/**
 * What the gate resolved, tied to the resource it resolved it for:
 * `ctx.gated` behind a `projectMember` gate with a `lookup`, null for an
 * admin (who skips the gate) or behind any other kind of gate.
 */
export interface Gated {
  kind: GatedKind;
  id: string;
  projectId: string;
}

/** The gate lookup of a run's project (`runProjectQuery`). */
export function runLookup(runId: string): GateLookup {
  return { kind: "run", id: runId, query: runProjectQuery(runId) };
}

/** The gate lookup of a build's project (`buildProjectQuery`). */
export function buildLookup(buildId: string): GateLookup {
  return { kind: "build", id: buildId, query: buildProjectQuery(buildId) };
}

/** The gate lookup of a review action's project (`actionProjectQuery`). */
export function actionLookup(actionId: string): GateLookup {
  return { kind: "action", id: actionId, query: actionProjectQuery(actionId) };
}

/**
 * The project `gated` holds for the `kind` resource `id`, or null when it is
 * about another resource (or absent): a handler trusts the gate's resolution
 * only for the very resource it acts on, and reads any other itself.
 */
export function gatedProjectOf(
  gated: Gated | null,
  kind: GatedKind,
  id: string,
): string | null {
  return gated !== null && gated.kind === kind && gated.id === id
    ? gated.projectId
    : null;
}

/** The project a `*ProjectQuery` lookup finds, or null. One statement. */
async function resolveProject(
  db: DB | Tx,
  lookup: SQL,
): Promise<string | null> {
  const rows = await db.execute<{ project_id: string }>(lookup);
  return rows[0]?.project_id ?? null;
}

/** The project a run belongs to, or null when there is no such run. */
export function resolveRunProject(
  db: DB | Tx,
  runId: string,
): Promise<string | null> {
  return resolveProject(db, runProjectQuery(runId));
}

/** The project a build belongs to, or null when there is no such build. */
function resolveBuildProject(
  db: DB | Tx,
  buildId: string,
): Promise<string | null> {
  return resolveProject(db, buildProjectQuery(buildId));
}

/**
 * The project a review action belongs to (its oldest decision's, see
 * {@link actionProjectQuery}), or null when there is no such action.
 */
function resolveActionProject(
  db: DB | Tx,
  actionId: string,
): Promise<string | null> {
  return resolveProject(db, actionProjectQuery(actionId));
}

/**
 * The run's project, NOT_FOUND when there is no such run.
 *
 * `gated` is what the membership gate resolved (`ctx.gated`). When it is for
 * this same run (a gate on `runLookup(runId)`), nothing is read. Otherwise
 * (an admin, who skips the gate; a gate on another resource) the run is read
 * here, with the same lookup.
 */
export async function requireRunProject(
  db: DB | Tx,
  runId: string,
  gated: Gated | null = null,
): Promise<string> {
  const projectId =
    gatedProjectOf(gated, "run", runId) ?? (await resolveRunProject(db, runId));
  if (!projectId) throw reviewError("NOT_FOUND", "run_not_found");
  return projectId;
}

/** {@link requireRunProject} for a review action; NOT_FOUND `action_not_found`. */
export async function requireActionProject(
  db: DB | Tx,
  actionId: string,
  gated: Gated | null = null,
): Promise<string> {
  const projectId =
    gatedProjectOf(gated, "action", actionId) ??
    (await resolveActionProject(db, actionId));
  if (!projectId) throw reviewError("NOT_FOUND", "action_not_found");
  return projectId;
}

/** {@link requireRunProject} for a build; NOT_FOUND `build_not_found`. */
export async function requireBuildProject(
  db: DB | Tx,
  buildId: string,
  gated: Gated | null = null,
): Promise<string> {
  const projectId =
    gatedProjectOf(gated, "build", buildId) ??
    (await resolveBuildProject(db, buildId));
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
 *
 * `knownBuilds` maps runs to their builds when the caller already read them
 * (the decision core locked the runs it decided): the builds are read only
 * when some run is missing from it.
 */
export async function announceRuns(
  ctx: ReviewActionCtx,
  projectId: string,
  runIds: string[],
  knownBuilds: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  if (runIds.length === 0) return;
  const rows = runIds.every((id) => knownBuilds.has(id))
    ? runIds.map((id) => ({ buildId: knownBuilds.get(id)! }))
    : await ctx.tx
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
  const { result, buildIdByRun } = await decideCheckpointsWithBuilds(
    ctx.tx,
    { ...input, actor: ctx.actor, targets: selection.targets },
    ctx.deps,
  );
  await announceRuns(
    ctx,
    input.projectId,
    result.runs.map((r) => r.runId),
    buildIdByRun,
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
 * (`GROUP_APPROVE_CAP`, capture order): `review.approveGroup` /
 * `review.rejectGroup`.
 *
 * The group is re-derived on the server (never a client list): the build's
 * checkpoints with the seed's diff signature, filtered by the core's own
 * pending rule, in the project resolved here (R18). A seed without a signature
 * (VLM / auto-approved / no meaningful diff) has no group; the empty selection
 * still lets the core replay a known actionId. NOT_FOUND for an unknown run or
 * checkpoint, BAD_REQUEST for a checkpoint of another run. `gated` is
 * `ctx.gated` behind a gate on `runLookup(input.runId)` (see
 * `requireRunProject`).
 */
export async function decideGroup(
  ctx: ReviewActionCtx,
  input: { runId: string; checkpointId: string; actionId: string },
  decision: CheckpointDecisionKind,
  gated: Gated | null = null,
): Promise<ReviewResult> {
  const projectId = await requireRunProject(ctx.tx, input.runId, gated);
  const seed = await loadGroupSeed(ctx.tx, input, projectId);

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
