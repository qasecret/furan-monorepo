import { builds, eq, inArray, testRuns, type Tx } from "@furan/db";
import type {
  ApproveBuildPreview,
  CheckpointDecisionKind,
} from "@furan/shared-types";
import { z } from "zod";

import { emitAudit } from "../../lib/emit-audit.js";
import {
  decideCheckpoints,
  selectPendingTargets,
  type DecideDeps,
  type DecideInput,
  type DecideResult,
  type ReviewTarget,
} from "../../lib/review/decide.js";
import { reviewError } from "../../lib/review/errors.js";
import {
  lockBuildRuns,
  selectUndecidedTargets,
  type SelectionScope,
} from "../../lib/review/targets.js";
import type { AuthedUser } from "../../plugins/auth.js";
import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { publicProcedure, t } from "../trpc.js";

import {
  GROUP_APPROVE_CAP,
  groupScope,
  loadGroupSeed,
} from "./checkpoint-grouping.js";
import { ignoreRegionElementSchema, MAX_IGNORE_REGIONS } from "./runs.js";

/**
 * The `review` router (spec §5.2): the per-checkpoint approve / reject, the
 * group actions and the build-wide "approve pending", all on top of the one
 * decision core (`decideCheckpoints`). The router chooses WHAT to decide and
 * announces the result; the core decides whether it is legal, writes it
 * atomically and recomputes the run status.
 *
 * Every procedure resolves its project from the run or build (resolve-then-gate,
 * like `runs.getById`): admins bypass the membership check, guests are refused,
 * anyone else must be a member. An admin skips the gate's resolver, so each
 * handler resolves the project again and answers NOT_FOUND for an unknown id.
 */

/** "Approve pending in a build" decides at most this many checkpoints per call. */
export const APPROVE_BUILD_CAP = 500;
/** "Approve / reject all" in one run, and the most ids one call may name. */
const RUN_CAP = 500;
const CHECKPOINT_IDS_MAX = 500;
const REASON_MAX = 500;
/** How many checkpoint ids a build-level audit row lists; `count` has the total. */
const AUDIT_CHECKPOINT_IDS_CAP = 50;

const uuid = z.string().uuid();
const actionIdSchema = uuid;
const checkpointIdsSchema = z.array(uuid).min(1).max(CHECKPOINT_IDS_MAX);

const approveInput = z.object({
  runId: uuid,
  actionId: actionIdSchema,
  checkpointIds: checkpointIdsSchema.optional(),
  ignoreAreas: z
    .array(ignoreRegionElementSchema)
    .max(MAX_IGNORE_REGIONS)
    .optional(),
});
const rejectInput = z.object({
  runId: uuid,
  actionId: actionIdSchema,
  checkpointIds: checkpointIdsSchema.optional(),
  reason: z.string().max(REASON_MAX).optional(),
});
const groupInput = z.object({
  runId: uuid,
  checkpointId: uuid,
  actionId: actionIdSchema,
});
const buildInput = z.object({ buildId: uuid });
const approveBuildInput = z.object({
  buildId: uuid,
  actionId: actionIdSchema,
  /** The pending count the reviewer confirmed (the preview's `pendingCheckpoints`). */
  expectedCount: z.number().int().min(0),
});

/**
 * A decision result plus whether the cap cut the action short. `capped` means
 * "pending checkpoints remain: run it again to continue". On a replay (a retry
 * of an action that already ran) it is read from what is still pending now.
 */
export interface ReviewResult extends DecideResult {
  capped: boolean;
  cap: number;
}

/** What the handlers use of the procedure context (after `authed`). */
interface ReviewCtx {
  db: Context["db"];
  user: AuthedUser;
  telemetry: Context["telemetry"];
  broadcaster: Context["broadcaster"];
  req: Context["req"];
  onCommit: (effect: () => unknown) => void;
}

/** `ctx.db` is the request transaction (`scopeToUser`), which is what the core needs. */
const txOf = (ctx: Pick<ReviewCtx, "db">): Tx => ctx.db as unknown as Tx;

const depsOf = (ctx: ReviewCtx): DecideDeps => ({
  registry: ctx.telemetry.metrics,
  logger: ctx.req.log,
});

// ---------------------------------------------------------------------------
// Project resolution (the gate's resolvers, and the handlers' own lookups).
// ---------------------------------------------------------------------------

/** The project a run belongs to, or null when there is no such run. */
export async function resolveRunProject(
  ctx: Pick<Context, "db">,
  runId: string,
): Promise<string | null> {
  const rows = await ctx.db
    .select({ projectId: testRuns.projectId })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/** The project a build belongs to, or null when there is no such build. */
export async function resolveBuildProject(
  ctx: Pick<Context, "db">,
  buildId: string,
): Promise<string | null> {
  const rows = await ctx.db
    .select({ projectId: builds.projectId })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

async function requireRunProject(
  ctx: Pick<Context, "db">,
  runId: string,
): Promise<string> {
  const projectId = await resolveRunProject(ctx, runId);
  if (!projectId) throw reviewError("NOT_FOUND", "run_not_found");
  return projectId;
}

async function requireBuildProject(
  ctx: Pick<Context, "db">,
  buildId: string,
): Promise<string> {
  const projectId = await resolveBuildProject(ctx, buildId);
  if (!projectId) throw reviewError("NOT_FOUND", "build_not_found");
  return projectId;
}

// ---------------------------------------------------------------------------
// Shared pieces.
// ---------------------------------------------------------------------------

/**
 * Queues the project events for a result, to go out after the request commits:
 * `testRun_updated` for every affected run (ascending id) and `build_updated`
 * once per affected build. A replay announces again — the events are idempotent
 * "refetch" hints, and the original's broadcast may have been lost.
 */
async function announce(
  ctx: ReviewCtx,
  projectId: string,
  runIds: string[],
): Promise<void> {
  if (runIds.length === 0) return;
  const rows = await ctx.db
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

/** Whether any checkpoint in `scope` is still pending (what "capped" means on a replay). */
async function anyPending(ctx: ReviewCtx, scope: SelectionScope) {
  const { preview } = await selectPendingTargets(txOf(ctx), scope, 0);
  return preview.pendingCheckpoints > 0;
}

interface Selection {
  targets: ReviewTarget[];
  /** The cap cut the selection short. */
  capped: boolean;
  cap: number;
  /** Where "still pending?" is asked when this action turns out to be a replay. */
  scope?: SelectionScope;
}

const explicitSelection = (
  runId: string,
  checkpointIds: string[],
): Selection => ({
  targets: checkpointIds.map((screenshotId) => ({ runId, screenshotId })),
  capped: false,
  cap: CHECKPOINT_IDS_MAX,
});

/** Runs the core for a selection, queues the broadcasts and shapes the result. */
async function decideSelection(
  ctx: ReviewCtx,
  input: Omit<DecideInput, "actor" | "targets">,
  selection: Selection,
): Promise<ReviewResult> {
  const result = await decideCheckpoints(
    txOf(ctx),
    { ...input, actor: ctx.user, targets: selection.targets },
    depsOf(ctx),
  );
  await announce(
    ctx,
    input.projectId,
    result.runs.map((r) => r.runId),
  );
  const capped = result.replayed
    ? selection.scope !== undefined && (await anyPending(ctx, selection.scope))
    : selection.capped;
  return { ...result, capped, cap: selection.cap };
}

/**
 * One build-level audit row for an action that spans runs (the core already
 * wrote one per run). Nothing for a replay or an action that decided nothing.
 */
async function auditBatch(
  ctx: ReviewCtx,
  action: "run.approve_build" | "run.approve_group" | "run.reject_group",
  buildId: string,
  projectId: string,
  source: "batch" | "group",
  result: ReviewResult,
  extra: Record<string, unknown>,
): Promise<void> {
  if (result.replayed || result.decided.length === 0) return;
  await emitAudit(
    ctx.db,
    {
      actorId: ctx.user.id,
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
    ctx.req.log,
  );
}

/** The pending members of `checkpointId`'s group, decided together as one action. */
async function decideGroup(
  ctx: ReviewCtx,
  input: z.infer<typeof groupInput>,
  decision: CheckpointDecisionKind,
): Promise<ReviewResult> {
  const projectId = await requireRunProject(ctx, input.runId);
  // NOT_FOUND for an unknown checkpoint, BAD_REQUEST for one in another run.
  const seed = await loadGroupSeed(ctx.db, input);

  // Re-derived on the server (never a client list): the build's checkpoints
  // with the seed's diff signature, filtered by the core's own pending rule.
  // A seed without a signature (VLM / auto-approved / no meaningful diff) has
  // no group; the empty selection still lets the core replay a known actionId.
  const scope = groupScope(seed, projectId) ?? undefined;
  const selected = scope
    ? await selectPendingTargets(txOf(ctx), scope, GROUP_APPROVE_CAP)
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
  await auditBatch(
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

// ---------------------------------------------------------------------------
// The router.
// ---------------------------------------------------------------------------

export const reviewRouter = t.router({
  /**
   * Approves `checkpointIds`, or every pending checkpoint of the run when none
   * are given. Explicit ids go to the core as they are: it refuses an illegal
   * one atomically (`PRECONDITION_FAILED` + `details.reasons`, or `CONFLICT
   * already_decided`). `ignoreAreas` (ADR-036) need exactly one explicit id.
   */
  approve: publicProcedure
    .input(approveInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProject(ctx, input.runId),
        },
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ReviewResult> => {
      const projectId = await requireRunProject(ctx, input.runId);
      if (
        input.ignoreAreas !== undefined &&
        input.checkpointIds === undefined
      ) {
        throw reviewError(
          "BAD_REQUEST",
          "ignore_areas_need_a_single_approve_target",
        );
      }
      const scope: SelectionScope = { projectId, runId: input.runId };
      let selection: Selection;
      if (input.checkpointIds) {
        selection = explicitSelection(input.runId, input.checkpointIds);
      } else {
        const { targets, preview } = await selectPendingTargets(
          txOf(ctx),
          scope,
          RUN_CAP,
        );
        selection = { targets, capped: preview.capped, cap: RUN_CAP, scope };
      }
      return decideSelection(
        ctx,
        {
          projectId,
          actionId: input.actionId,
          source: "viewer",
          decision: "approved",
          ...(input.ignoreAreas !== undefined
            ? { ignoreAreas: input.ignoreAreas }
            : {}),
        },
        selection,
      );
    }),

  /**
   * Rejects `checkpointIds`, or every pending checkpoint of the run; when
   * nothing is pending, every undecided checkpoint (spec §5.2, the backfill
   * rule), so a run that only has passed steps can still be rejected.
   */
  reject: publicProcedure
    .input(rejectInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProject(ctx, input.runId),
        },
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ReviewResult> => {
      const projectId = await requireRunProject(ctx, input.runId);
      const scope: SelectionScope = { projectId, runId: input.runId };
      let selection: Selection;
      if (input.checkpointIds) {
        selection = explicitSelection(input.runId, input.checkpointIds);
      } else {
        const pending = await selectPendingTargets(txOf(ctx), scope, RUN_CAP);
        if (pending.targets.length > 0) {
          selection = {
            targets: pending.targets,
            capped: pending.preview.capped,
            cap: RUN_CAP,
            scope,
          };
        } else {
          const undecided = await selectUndecidedTargets(
            txOf(ctx),
            { projectId, runId: input.runId },
            RUN_CAP,
          );
          selection = {
            targets: undecided.targets,
            capped: undecided.total > RUN_CAP,
            cap: RUN_CAP,
            scope,
          };
        }
      }
      return decideSelection(
        ctx,
        {
          projectId,
          actionId: input.actionId,
          source: "viewer",
          decision: "rejected",
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
        selection,
      );
    }),

  /** Approves the pending members of the checkpoint's group (`GROUP_APPROVE_CAP`). */
  approveGroup: publicProcedure
    .input(groupInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProject(ctx, input.runId),
        },
      }),
    )
    .mutation(({ ctx, input }) => decideGroup(ctx, input, "approved")),

  /** Rejects the pending members of the checkpoint's group (`GROUP_APPROVE_CAP`). */
  rejectGroup: publicProcedure
    .input(groupInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProject(ctx, input.runId),
        },
      }),
    )
    .mutation(({ ctx, input }) => decideGroup(ctx, input, "rejected")),

  /** What `approveBuild` would approve now. Read-only, takes no locks. */
  previewApproveBuild: publicProcedure
    .input(buildInput)
    .use(authed)
    .use(
      projectMember<{ buildId: string }>("read", {
        from: {
          resolver: ({ input, ctx }) => resolveBuildProject(ctx, input.buildId),
        },
      }),
    )
    .query(async ({ ctx, input }): Promise<ApproveBuildPreview> => {
      const projectId = await requireBuildProject(ctx, input.buildId);
      const { preview } = await selectPendingTargets(
        txOf(ctx),
        { projectId, buildId: input.buildId },
        APPROVE_BUILD_CAP,
      );
      return preview;
    }),

  /**
   * Approves every pending checkpoint of a build, at most `APPROVE_BUILD_CAP`
   * in capture order (running it again drains the rest). What the reviewer
   * confirmed is what gets approved: the build's runs are locked FIRST, the
   * pending set is counted under those locks, and a count that differs from
   * `expectedCount` is `CONFLICT batch_changed` with the fresh preview. A
   * rejected step stays rejected and a run that is not reviewable is skipped.
   */
  approveBuild: publicProcedure
    .input(approveBuildInput)
    .use(authed)
    .use(
      projectMember<{ buildId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveBuildProject(ctx, input.buildId),
        },
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ReviewResult> => {
      const projectId = await requireBuildProject(ctx, input.buildId);
      const tx = txOf(ctx);
      const base = {
        projectId,
        actionId: input.actionId,
        source: "batch",
        decision: "approved",
      } as const;
      const scope: SelectionScope = { projectId, buildId: input.buildId };

      // 1. Lock the build's runs (ascending id, FOR NO KEY UPDATE). Everything
      //    below sees the state no concurrent decision can change under us.
      await lockBuildRuns(tx, projectId, input.buildId);

      // 2. A retry of an action that already ran replays its stored result,
      //    BEFORE the count is compared: pending is 0 now, which is not what
      //    the reviewer confirmed. (The core replays a known actionId even
      //    when it has nothing to decide; with no targets it writes nothing.)
      const probe = await decideSelection(ctx, base, {
        targets: [],
        capped: false,
        cap: APPROVE_BUILD_CAP,
        scope,
      });
      if (probe.replayed) return probe;

      // 3. Count what is pending, under the locks, and compare.
      const { targets, preview } = await selectPendingTargets(
        tx,
        scope,
        APPROVE_BUILD_CAP,
      );
      if (preview.pendingCheckpoints !== input.expectedCount) {
        throw reviewError("CONFLICT", "batch_changed", { preview });
      }

      // 4. Approve exactly that set. (The core locks the same runs again,
      //    which is free inside this transaction.)
      const result = await decideSelection(ctx, base, {
        targets,
        capped: preview.capped,
        cap: APPROVE_BUILD_CAP,
        scope,
      });
      await auditBatch(
        ctx,
        "run.approve_build",
        input.buildId,
        projectId,
        "batch",
        result,
        { expectedCount: input.expectedCount },
      );
      return result;
    }),
});
