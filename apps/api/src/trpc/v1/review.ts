import {
  and,
  asc,
  builds,
  eq,
  inArray,
  screenshots,
  testRuns,
  type DB,
  type Tx,
} from "@furan/db";
import type { ApproveBuildPreview } from "@furan/shared-types";
import { z } from "zod";

import {
  announceRuns,
  auditBuildAction,
  decideGroup,
  decideSelection,
  requireActionProject,
  requireBuildProject,
  requireRunProject,
  resolveActionProject,
  resolveBuildProject,
  resolveRunProject,
  trpcActionCtx,
  type ReviewResult,
  type Selection,
} from "../../lib/review/actions.js";
import { selectPendingTargets } from "../../lib/review/decide.js";
import { enqueueRunDiff } from "../../lib/review/enqueue.js";
import { reviewError } from "../../lib/review/errors.js";
import { recordReviewNext } from "../../lib/review/metrics.js";
import {
  findNext,
  type NextResult,
  type QueueAt,
} from "../../lib/review/queue.js";
import { revertAction, type RevertResult } from "../../lib/review/revert.js";
import {
  lockBuildRuns,
  selectUndecidedTargets,
  type SelectionScope,
} from "../../lib/review/targets.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { publicProcedure, t } from "../trpc.js";

import { ignoreRegionElementSchema, MAX_IGNORE_REGIONS } from "./runs.js";

export type { ReviewResult };

/** What `review.revert` returns: the core's result without the re-diffs it queued. */
export type RevertOutput = Omit<RevertResult, "rediffRunIds">;

/**
 * The `review` router (spec §5.2): the per-checkpoint approve / reject, the
 * group actions and the build-wide "approve pending", all on top of the one
 * decision core (`decideCheckpoints`). The router chooses WHAT to decide and
 * announces the result; the core decides whether it is legal, writes it
 * atomically and recomputes the run status.
 *
 * Every procedure but `next` resolves its project from the run, build or action
 * (resolve-then-gate, like `runs.getById`): admins bypass the membership check, guests are refused,
 * anyone else must be a member. An admin skips the gate's resolver, so each
 * handler resolves the project again and answers NOT_FOUND for an unknown id.
 * `next` is the read of the queue: the caller names the project, and the
 * handler checks that the ids it names belong to it.
 */

/** "Approve pending in a build" decides at most this many checkpoints per call. */
export const APPROVE_BUILD_CAP = 500;
/** "Approve / reject all" in one run, and the most ids one call may name. */
const RUN_CAP = 500;
const CHECKPOINT_IDS_MAX = 500;
const REASON_MAX = 500;

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
const revertInput = z.object({ actionId: actionIdSchema });
/** At most this many batches may be skipped in one `review.next` call. */
const EXCLUDE_BUILDS_MAX = 50;
const nextInput = z.object({
  projectId: uuid,
  /** Where the reviewer is. Absent: start at the newest batch with a pending step. */
  at: z
    .object({
      buildId: uuid,
      runId: uuid.optional(),
      checkpointId: uuid.optional(),
    })
    // A step is named through its run.
    .refine((at) => at.checkpointId === undefined || at.runId !== undefined, {
      message: "checkpoint_requires_run",
    })
    .optional(),
  direction: z.enum(["next", "prev"]).optional(),
  facets: z
    .object({
      browser: z.string().min(1).max(64).optional(),
      viewport: z.string().min(1).max(32).optional(),
      os: z.string().min(1).max(64).optional(),
      device: z.string().min(1).max(64).optional(),
    })
    .optional(),
  excludeBuildIds: z.array(uuid).max(EXCLUDE_BUILDS_MAX).optional(),
});
const approveBuildInput = z.object({
  buildId: uuid,
  actionId: actionIdSchema,
  /** The pending count the reviewer confirmed (the preview's `pendingCheckpoints`). */
  expectedCount: z.number().int().min(0),
});

const explicitSelection = (
  runId: string,
  checkpointIds: string[],
): Selection => ({
  targets: checkpointIds.map((screenshotId) => ({ runId, screenshotId })),
  capped: false,
  cap: CHECKPOINT_IDS_MAX,
});

/** Every `at` mismatch answers with this one message (see `requireAtInProject`). */
const AT_NOT_FOUND = "at_not_found";

/**
 * `findNext` trusts its `at` (spec §4.2), so the procedure checks it first:
 * the build is the project's, the run is that build's, the step is that run's.
 * One small lookup per id, each pinned to the project. Any mismatch (another
 * project's id, an unknown id, a step of another run) is the same NOT_FOUND
 * with the same message, so an id from another project is no different from one
 * that does not exist, and a caller cannot tell which link of the chain failed.
 * (A step without its run never gets here: the input schema refuses it.)
 */
async function requireAtInProject(
  db: DB | Tx,
  projectId: string,
  at: QueueAt,
): Promise<void> {
  const { buildId, runId, checkpointId } = at;
  const notFound = () => reviewError("NOT_FOUND", AT_NOT_FOUND);
  const [build] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.projectId, projectId)))
    .limit(1);
  if (!build) throw notFound();
  if (runId === undefined) {
    if (checkpointId !== undefined) throw notFound();
    return;
  }
  const [run] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.id, runId),
        eq(testRuns.buildId, buildId),
        eq(testRuns.projectId, projectId),
      ),
    )
    .limit(1);
  if (!run) throw notFound();
  if (checkpointId === undefined) return;
  const [step] = await db
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(
      and(
        eq(screenshots.id, checkpointId),
        eq(screenshots.runId, runId),
        eq(screenshots.projectId, projectId),
      ),
    )
    .limit(1);
  if (!step) throw notFound();
}

// ---------------------------------------------------------------------------
// The router.
// ---------------------------------------------------------------------------

export const reviewRouter = t.router({
  /**
   * Where the reviewer goes next (spec §4.2): the next pending step after
   * `at` in its batch (wrapping to the ones skipped), else the next batch's
   * first pending step; `direction: "prev"` walks backwards. Read-only,
   * takes no locks: the answer is a hint, and a decision it leads to is
   * checked by the decide paths. The gate is the project's, named by the
   * input (admins bypass membership; a guest is refused, as for every
   * project-scoped read); `at` must belong to it (`requireAtInProject`).
   */
  next: publicProcedure
    .input(nextInput)
    .use(authed)
    .use(
      projectMember<{ projectId: string }>("read", {
        from: { resolver: async ({ input }) => input.projectId },
      }),
    )
    .query(async ({ ctx, input }): Promise<NextResult> => {
      // The timer covers the whole handler, what the caller waits for.
      const started = performance.now();
      if (input.at) await requireAtInProject(ctx.db, input.projectId, input.at);
      const result = await findNext(ctx.db, input);
      recordReviewNext(
        ctx.telemetry.metrics,
        result.scope,
        (performance.now() - started) / 1000,
      );
      return result;
    }),

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
          resolver: ({ input, ctx }) => resolveRunProject(ctx.db, input.runId),
        },
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ReviewResult> => {
      const actx = trpcActionCtx(ctx);
      const projectId = await requireRunProject(actx.tx, input.runId);
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
          actx.tx,
          scope,
          RUN_CAP,
        );
        selection = { targets, capped: preview.capped, cap: RUN_CAP, scope };
      }
      return decideSelection(
        actx,
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
          resolver: ({ input, ctx }) => resolveRunProject(ctx.db, input.runId),
        },
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ReviewResult> => {
      const actx = trpcActionCtx(ctx);
      const projectId = await requireRunProject(actx.tx, input.runId);
      const scope: SelectionScope = { projectId, runId: input.runId };
      let selection: Selection;
      if (input.checkpointIds) {
        selection = explicitSelection(input.runId, input.checkpointIds);
      } else {
        const pending = await selectPendingTargets(actx.tx, scope, RUN_CAP);
        if (pending.targets.length > 0) {
          selection = {
            targets: pending.targets,
            capped: pending.preview.capped,
            cap: RUN_CAP,
            scope,
          };
        } else {
          const undecided = await selectUndecidedTargets(
            actx.tx,
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
        actx,
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
          resolver: ({ input, ctx }) => resolveRunProject(ctx.db, input.runId),
        },
      }),
    )
    .mutation(({ ctx, input }) =>
      decideGroup(trpcActionCtx(ctx), input, "approved"),
    ),

  /** Rejects the pending members of the checkpoint's group (`GROUP_APPROVE_CAP`). */
  rejectGroup: publicProcedure
    .input(groupInput)
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProject(ctx.db, input.runId),
        },
      }),
    )
    .mutation(({ ctx, input }) =>
      decideGroup(trpcActionCtx(ctx), input, "rejected"),
    ),

  /** What `approveBuild` would approve now. Read-only, takes no locks. */
  previewApproveBuild: publicProcedure
    .input(buildInput)
    .use(authed)
    .use(
      projectMember<{ buildId: string }>("read", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveBuildProject(ctx.db, input.buildId),
        },
      }),
    )
    .query(async ({ ctx, input }): Promise<ApproveBuildPreview> => {
      const actx = trpcActionCtx(ctx);
      const projectId = await requireBuildProject(actx.tx, input.buildId);
      const { preview } = await selectPendingTargets(
        actx.tx,
        { projectId, buildId: input.buildId },
        APPROVE_BUILD_CAP,
      );
      return preview;
    }),

  /**
   * Approves every pending checkpoint of a build, at most `APPROVE_BUILD_CAP`
   * in capture order (running it again drains the rest). What the reviewer
   * confirmed is what gets approved: the build's reviewable runs are locked
   * FIRST, the pending set is counted under those locks, and a count that
   * differs from `expectedCount` is `CONFLICT batch_changed` with the fresh
   * preview. A rejected step stays rejected and a run that is not reviewable
   * is skipped (and never locked).
   */
  approveBuild: publicProcedure
    .input(approveBuildInput)
    .use(authed)
    .use(
      projectMember<{ buildId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveBuildProject(ctx.db, input.buildId),
        },
      }),
    )
    .mutation(async ({ ctx, input }): Promise<ReviewResult> => {
      const actx = trpcActionCtx(ctx);
      const projectId = await requireBuildProject(actx.tx, input.buildId);
      const tx = actx.tx;
      const base = {
        projectId,
        actionId: input.actionId,
        source: "batch",
        decision: "approved",
      } as const;
      const scope: SelectionScope = { projectId, buildId: input.buildId };

      // 1. Lock the build's runs that can be targets (reviewable, not
      //    overridden; ascending id, FOR NO KEY UPDATE). Everything below
      //    sees the state no concurrent decision can change under us.
      const lockedRuns = await lockBuildRuns(tx, projectId, input.buildId);

      // 2. A retry of an action that already ran replays its stored result,
      //    BEFORE the count is compared: pending is 0 now, which is not what
      //    the reviewer confirmed. (The core replays a known actionId even
      //    when it has nothing to decide; with no targets it writes nothing.)
      const probe = await decideSelection(actx, base, {
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
      // A run that became reviewable after step 1 holds no lock of ours, and
      // locking it now would break the ascending order: the build changed
      // under the reviewer, so they confirm again.
      if (
        preview.pendingCheckpoints !== input.expectedCount ||
        targets.some((t) => !lockedRuns.has(t.runId))
      ) {
        throw reviewError("CONFLICT", "batch_changed", { preview });
      }

      // 4. Approve exactly that set. (The core locks the same runs again,
      //    which is free inside this transaction.)
      const result = await decideSelection(actx, base, {
        targets,
        capped: preview.capped,
        cap: APPROVE_BUILD_CAP,
        scope,
      });
      await auditBuildAction(
        actx,
        "run.approve_build",
        input.buildId,
        projectId,
        "batch",
        result,
        { expectedCount: input.expectedCount },
      );
      return result;
    }),

  /**
   * Undoes review action `actionId` (spec §5.3): the decider or an admin, until
   * something newer has built on top of it. Skips are reported per checkpoint,
   * not fatal. The gate's project is the one of the action's oldest decision,
   * and the core acts in that project only (an action id may exist in two).
   *
   * After commit: the project is told which runs changed, then a re-diff is
   * queued for every run in `rediffRunIds` (with the run's parent branch like
   * the upload that first diffed it). A retry announces again, and queues
   * again a run that still waits for its diff (R30); the events are
   * idempotent refresh hints.
   */
  revert: publicProcedure
    .input(revertInput)
    .use(authed)
    .use(
      projectMember<{ actionId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveActionProject(ctx.db, input.actionId),
        },
      }),
    )
    .mutation(async ({ ctx, input }): Promise<RevertOutput> => {
      const actx = trpcActionCtx(ctx);
      const projectId = await requireActionProject(actx.tx, input.actionId);
      const { rediffRunIds, ...result } = await revertAction(
        actx.tx,
        { actor: actx.actor, actionId: input.actionId, projectId },
        actx.deps,
      );
      // Announce first: the after-commit effects run in order, and a failing
      // `enqueue` (queue down) stops the ones behind it. Publishing never
      // throws (the broadcaster swallows its errors), so announcing first
      // costs nothing and viewers still refresh when only the queue fails.
      await announceRuns(
        actx,
        projectId,
        result.runs.map((r) => r.runId),
      );
      if (rediffRunIds.length > 0) {
        const rediffs = await actx.tx
          .select({
            id: testRuns.id,
            projectId: testRuns.projectId,
            parentBranchName: testRuns.parentBranchName,
          })
          .from(testRuns)
          .where(inArray(testRuns.id, rediffRunIds))
          .orderBy(asc(testRuns.id));
        for (const run of rediffs) enqueueRunDiff(ctx, run, "undo");
      }
      return result;
    }),
});
