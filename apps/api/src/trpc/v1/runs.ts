import {
  and,
  asc,
  baselines,
  builds,
  desc,
  diffRegions,
  eq,
  ilike,
  inArray,
  isNull,
  projects,
  resolveBaseline,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type RunStatus,
} from "@furan/db";
import {
  overrideStatusInputSchema,
  runStatusSchema,
} from "@furan/shared-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { emitAudit } from "../../lib/emit-audit.js";
import {
  cursorTimestamp,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../../lib/keyset-cursor.js";
import {
  checkpointStatusAlias,
  loadCheckpointReview,
  NO_REVIEW,
  type CheckpointReviewView,
} from "../../lib/review/reads.js";
import { selectPendingTargets } from "../../lib/review/targets.js";
import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { publicProcedure, t } from "../trpc.js";

import {
  approveCheckpointInTx,
  approveRunInTx,
  GROUP_APPROVE_CAP,
  groupScope,
  loadGroupSeed,
} from "./checkpoint-grouping.js";

const runIdInput = z.object({ runId: z.string().uuid() });
type RunIdInput = z.infer<typeof runIdInput>;

type IgnoreRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewport?: string;
};

/**
 * Shape of a single ignore-region element. Extracted to a module-level
 * const so `setIgnoreAreas` (replace mode) and `addIgnoreAreas` (append
 * mode) share the same validation rules — the accepted kinds, regex
 * pattern requirement for dynamic-text, thresholdOverride only on strict.
 *
 * Caller-facing units stay in image-pixel space (matching screenshot
 * dimensions); the worker re-applies viewport filtering at diff time.
 */
export const ignoreRegionElementSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    viewport: z.string().min(1).max(32),
    paddingPx: z.number().int().min(0).max(32).default(0),
    /**
     * Match mode:
     * - `ignore`: skip the region entirely (masked out of the L1 pixel diff).
     * - `dynamic-text`: mask in L1 only when OCR'd text matches `pattern`.
     * - `strict`: don't mask; region is informational. When
     *   `thresholdOverride` is set, the engine will (TODO) apply that
     *   tighter threshold locally. Until the engine work lands, strict
     *   regions are pure metadata — useful as visual review markers
     *   ("this area MUST match"). See furan-design/specs/2026-05-23-region-modes-design.md.
     * - `layout`: mask the region in L1 (suppresses pixel diff inside)
     *   + visual marker. Kept as a distinct kind for review semantics;
     *   image-first (ADR-047) dropped the planned L2 layout-only compare.
     * - `content`: same behavior as layout — masked in L1, stored as a
     *   distinct kind. (The planned L2 text-content compare was dropped
     *   in ADR-047's image-first re-aim.)
     */
    kind: z
      .enum(["ignore", "dynamic-text", "strict", "layout", "content"])
      .default("ignore"),
    pattern: z.string().min(1).max(500).optional(),
    selector: z.string().min(1).max(500).optional(),
    /**
     * Optional per-region threshold override for `kind: "strict"`,
     * matching the units of `projects.diffThreshold` (0..1).
     * Stored on the region but not yet honored by the engine — see
     * design doc. Rejected for non-strict kinds so callers can't
     * accidentally smuggle it onto an ignore region.
     */
    thresholdOverride: z.number().min(0).max(1).optional(),
  })
  .refine(
    (r) =>
      r.kind !== "dynamic-text" ||
      (r.pattern !== undefined && r.pattern.length > 0),
    { message: "pattern is required when kind is dynamic-text" },
  )
  .superRefine((r, ctx) => {
    if (r.kind === "dynamic-text" && r.pattern !== undefined) {
      try {
        new RegExp(r.pattern, "i");
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid regex: ${(err as Error).message}`,
          path: ["pattern"],
        });
      }
    }
    // thresholdOverride is only meaningful for strict regions. Smuggling
    // it onto an ignore region would silently mask intent (e.g., "I
    // wanted this to fail if any pixel differs" becomes "I ignored this
    // entirely") — reject up front.
    if (r.thresholdOverride !== undefined && r.kind !== "strict") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `thresholdOverride is only valid for kind="strict" (got "${r.kind}")`,
        path: ["thresholdOverride"],
      });
    }
  });

/**
 * Total cap on the COMBINED ignore-region list per (scope, run/variation).
 * Enforced by setIgnoreAreas via `.max(50)` on the array; addIgnoreAreas
 * checks `existing.length + incoming.length <= MAX_IGNORE_REGIONS` so
 * append-mode can't exceed the same ceiling.
 */
export const MAX_IGNORE_REGIONS = 50;

type IgnoreRegionElement = z.infer<typeof ignoreRegionElementSchema>;

const listInput = z.object({
  projectId: z.string().uuid(),
  /** Opaque keyset cursor: the previous page's `nextCursor`. */
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  /** Exact-match filter on `test_runs.branch_name`. */
  branch: z.string().min(1).max(255).optional(),
  /**
   * Multi-select filter on `test_runs.status`. Each element is narrowed to
   * the typed `runStatusSchema` enum (the seven run-status values)
   * so the boundary rejects unknown values up front rather than silently
   * returning an empty page. Spec §3.5: reviewers can combine e.g.
   * "Unresolved + Failed" simultaneously.
   *
   * Semantics: `undefined` OR an empty array means "no filter" (return
   * all statuses); a non-empty array translates to `status IN (...)`.
   */
  status: runStatusSchema.array().optional(),
  /** Optional filter to runs under a single build (drill-in from Builds tab). */
  buildId: z.string().uuid().optional(),
  /**
   * Exact-match filters on the device/environment columns. The legacy
   * frontend exposed all of these in its DataGrid filter row; furan kept
   * branch + status only at launch and is now filling the gap. Empty
   * string is rejected at the boundary (`.min(1)`) so the "no filter"
   * state is unambiguously `undefined` rather than `""`. customTags is
   * ILIKE-substring rather than exact because the column is a comma-
   * separated free-form bag in legacy usage ("smoke,login,critical")
   * and exact-match would force the caller to know the full string.
   */
  browser: z.string().min(1).max(64).optional(),
  viewport: z.string().min(1).max(32).optional(),
  os: z.string().min(1).max(64).optional(),
  device: z.string().min(1).max(64).optional(),
  customTags: z.string().min(1).max(255).optional(),
});
type ListInput = z.infer<typeof listInput>;

/**
 * The legal source statuses for any reviewer-driven status mutation
 * (`approve`, `reject`, `overrideStatus`) per spec §3.3. Excludes
 * `running` (no diff outcome yet) and the terminal system states
 * `new | aborted | empty` (re-run instead of overriding).
 */
const REVIEWER_LEGAL_FROM: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "passed",
  "unresolved",
  "failed",
]);

/** `selectPendingTargets` with no cap: the caller applies its own limit. */
const NO_SELECTION_CAP = Number.MAX_SAFE_INTEGER;

/**
 * Statuses that the `approve` mutation accepts. Superset of
 * REVIEWER_LEGAL_FROM that additionally allows `new` per ADR-036:
 * when `project.autoApproveFeature = false`, first-baseline runs land
 * with status=new and no `baselines` row. The reviewer's approve
 * materialises the baseline (mirroring the legacy backend's
 * `approve()` semantics). Reject + overrideStatus stay on the strict
 * REVIEWER_LEGAL_FROM set — there's no diff outcome to reject and no
 * status to override before a baseline exists.
 */
const APPROVE_LEGAL_FROM: ReadonlySet<RunStatus> = new Set<RunStatus>([
  ...REVIEWER_LEGAL_FROM,
  "new",
]);

/**
 * Every approve path's status gate (run-level, per-checkpoint, approve-all):
 * review terminal states plus `new` (spec §3.3, ADR-036). Mid-flight
 * (`running`) and other system states (`aborted`, `empty`) are rejected — for
 * those the right response is to re-run.
 */
function assertApprovable(status: RunStatus): void {
  if (!APPROVE_LEGAL_FROM.has(status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot approve a run with status '${status}'. Re-run the test instead.`,
    });
  }
}

/**
 * Approve a single test run: transitions status → passed, sets merge=true,
 * promotes the baseline of EVERY checkpoint (approveRunInTx), and publishes
 * broadcaster events. Shared by `runs.approve`, `inbox.approve` and the REST
 * `POST /runs/:id/approve` so all callers apply identical side effects.
 *
 * Throws TRPCError NOT_FOUND if the run doesn't exist, BAD_REQUEST if its
 * status isn't in APPROVE_LEGAL_FROM.
 */
export async function approveRun(
  ctx: {
    db: import("@furan/db").DB;
    broadcaster: import("../../lib/broadcast.js").Broadcaster;
    user: { id: string };
    /**
     * When the caller runs inside a request-scoped transaction (ADR-058), the
     * inner `ctx.db.transaction()` below becomes a savepoint, so this helper's
     * "broadcast after commit" would otherwise fire before the OUTER commit.
     * Passing `onCommit` defers the broadcasts until after that commit; absent
     * (a non-scoped caller), they run inline post-(inner-)commit as before.
     */
    onCommit?: (effect: () => unknown) => void;
    /** Best-effort audit sink; omit to skip the audit write (e.g. tests). */
    log?: { error: (obj: object, msg: string) => void };
  },
  runId: string,
  /**
   * ADR-036: when provided, the drawn ignore regions are persisted onto the
   * first checkpoint's variation as part of approval — so "Save as baseline"
   * doesn't drop regions the reviewer drew but hadn't separately saved.
   * `undefined` keeps every variation's saved regions (the inbox/REST callers).
   */
  ignoreAreas?: IgnoreRegionElement[] | null,
): Promise<{ runId: string; approved: true }> {
  // All DB reads + writes are wrapped in a single transaction so the
  // status check and the subsequent UPDATE + INSERT are atomic. Two
  // concurrent approves of the same run cannot both pass the check and
  // both insert a baseline (TOCTOU fix — #14).
  //
  // Broadcaster calls are intentionally kept OUTSIDE the transaction: they
  // are best-effort side-effects that must not roll back DB work if they
  // fail, and the DB must be committed before consumers see the event.
  const { run, checkpointIds } = await ctx.db.transaction(async (tx) => {
    const runRows = await tx
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, runId))
      .limit(1);
    const run = runRows[0];
    if (!run) throw new TRPCError({ code: "NOT_FOUND" });

    assertApprovable(run.status);

    // ADR-067: promote every checkpoint (a checkpoint-less run still flips to
    // passed). ADR-036: reviewer-drawn regions persist in the same flow — no
    // separate diff enqueue, so nothing races the status=passed write.
    const { checkpointIds } = await approveRunInTx(
      tx,
      run,
      ctx.user.id,
      ignoreAreas,
    );

    return { run, checkpointIds };
  });

  // Broadcaster calls after commit — consumers refetch committed state. When
  // the caller is request-scoped these defer to after the OUTER commit (see
  // the onCommit note above); otherwise they run inline now.
  const broadcast = async (): Promise<void> => {
    await ctx.broadcaster.publishProjectEvent(run.projectId, {
      event: "testRun_updated",
      data: { id: run.id },
    });
    if (run.buildId) {
      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "build_updated",
        data: { id: run.buildId },
      });
    }
  };
  if (ctx.onCommit) ctx.onCommit(broadcast);
  else await broadcast();

  // Audit the baseline-affecting approval (best-effort; ADR-058: on the
  // request-scoped db so it commits with the outer tx). Skipped when no log
  // sink is threaded through (unit callers that don't exercise audit).
  if (ctx.log) {
    await emitAudit(
      ctx.db,
      {
        actorId: ctx.user.id,
        action: "run.approve",
        targetType: "run",
        targetId: run.id,
        metadata: {
          projectId: run.projectId,
          buildId: run.buildId,
          checkpoints: checkpointIds.length,
          checkpointIds,
        },
      },
      ctx.log,
    );
  }

  return { runId: run.id, approved: true };
}

async function resolveRunProjectId(
  input: RunIdInput,
  ctx: Context,
): Promise<string | null> {
  const rows = await ctx.db
    .select({ projectId: testRuns.projectId })
    .from(testRuns)
    .where(eq(testRuns.id, input.runId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

/**
 * The non-status WHERE conditions `list` applies
 * (projectId + branch/buildId/customTags). A shared builder keeps filter
 * logic centralized so it can't drift when a dimension is added
 * (e.g. ADR-038 Phase 5 device filters).
 */
function runListBaseConditions(input: {
  projectId: string;
  branch?: string | undefined;
  buildId?: string | undefined;
  customTags?: string | undefined;
}) {
  const conditions = [eq(testRuns.projectId, input.projectId)];
  if (input.branch) conditions.push(eq(testRuns.branchName, input.branch));
  if (input.buildId) conditions.push(eq(testRuns.buildId, input.buildId));
  if (input.customTags) {
    // ILIKE substring against the comma-separated tag bag (SDK passes it
    // verbatim, e.g. "smoke,login,critical"); reviewers match on a substring.
    conditions.push(ilike(testRuns.customTags, `%${input.customTags}%`));
  }
  return conditions;
}

export const runsRouter = t.router({
  /**
   * Cursor-paginated run listing for the dashboard index page (T9).
   * Order: `created_at DESC, id DESC`. The opaque cursor is the last item's
   * full-µs `created_at` + id (lib/keyset-cursor.ts); we fetch `limit + 1`
   * rows and use the extra row to decide whether `nextCursor` should be set.
   */
  list: publicProcedure
    .input(listInput)
    .use(authed)
    .use(
      projectMember<ListInput>("read", {
        from: {
          resolver: ({ input }: { input: ListInput; ctx: Context }) =>
            Promise.resolve(input.projectId),
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      // ADR-038: browser/viewport/os/device filters moved to screenshots;
      // Phase 5 adds sub-query filters there. Shared base conditions keep
      // `list` consistent with any future filter expansions.
      const conditions = runListBaseConditions(input);
      const cursor = input.cursor ? decodeKeysetCursor(input.cursor) : null;
      if (cursor) {
        conditions.push(
          sql`(${testRuns.createdAt}, ${testRuns.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      // Empty array == no filter, identical to undefined — keeps the
      // dashboard's "all checkboxes off" state simple and avoids an
      // accidental `status IN ()` that would return zero rows.
      if (input.status && input.status.length > 0) {
        conditions.push(inArray(testRuns.status, input.status));
      }

      const rows = await ctx.db
        .select({
          run: testRuns,
          buildName: builds.name,
          buildNumber: builds.number,
          buildCiBuildId: builds.ciBuildId,
          buildBranchName: builds.branchName,
          buildCreatedAt: builds.createdAt,
          cursorAt: cursorTimestamp(testRuns.createdAt),
        })
        .from(testRuns)
        .leftJoin(builds, eq(testRuns.buildId, builds.id))
        .where(and(...conditions))
        .orderBy(desc(testRuns.createdAt), desc(testRuns.id))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      // Flatten the join: run columns stay top-level (back-compat with every
      // existing consumer) with the build display fields alongside so the
      // dashboard can group runs under their build (ADR-038 batch model).
      const items = page.map((r) => ({
        ...r.run,
        buildName: r.buildName,
        buildNumber: r.buildNumber,
        buildCiBuildId: r.buildCiBuildId,
        buildBranchName: r.buildBranchName,
        buildCreatedAt: r.buildCreatedAt,
      }));
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeKeysetCursor({ createdAt: last.cursorAt, id: last.run.id })
          : null;
      return { items, nextCursor };
    }),

  getById: publicProcedure
    .input(runIdInput)
    .use(authed)
    .use(
      projectMember<RunIdInput>("read", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProjectId(input, ctx),
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      const shots = await ctx.db
        .select()
        .from(screenshots)
        .where(eq(screenshots.runId, input.runId));
      const regions = await ctx.db
        .select()
        .from(diffRegions)
        .where(eq(diffRegions.runId, input.runId));

      // ADR-038: run-level ignoreAreas removed from test_runs. Return null.
      const runIgnoreAreas: IgnoreRegion[] | null = null;

      // ADR-038: sibling runs are now linked via the build/project, not
      // a single variation. Return null for prevRunId/nextRunId for now;
      // Phase 5 will implement the new navigation model.
      const prevRunId: string | null = null;
      const nextRunId: string | null = null;

      // ADR-032: autoApproved is true iff at least one baselines row
      // exists for this run with userId IS NULL (the system-approved
      // signal). Single PK-indexed lookup; cheap.
      const autoApprovedRows = await ctx.db
        .select({ id: baselines.id })
        .from(baselines)
        .where(
          and(eq(baselines.testRunId, input.runId), isNull(baselines.userId)),
        )
        .limit(1);
      const autoApproved = autoApprovedRows.length > 0;

      // Default branch is identical across all checkpoints in this run.
      // Look it up once instead of per checkpoint inside the resolution
      // loop. ADR-038 deferred per-checkpoint baseline resolution to
      // Phase 5; we now resolve it here.
      const projectRows = await ctx.db
        .select({ mainBranchName: projects.mainBranchName })
        .from(projects)
        .where(eq(projects.id, run.projectId))
        .limit(1);
      const defaultBranch = projectRows[0]?.mainBranchName ?? "main";

      // Resolve { baselineScreenshot, baselineSource, variationIgnoreAreas }
      // for one candidate screenshot. Failures in baseline resolution are
      // informational and degrade to nulls — same semantics as the old
      // first-checkpoint-only path; one bad variation must not kill the
      // whole getById response.
      type CheckpointContext = {
        baselineScreenshot: (typeof shots)[number] | null;
        baselineSource: string | null;
        variationIgnoreAreas: IgnoreRegion[] | null;
      };
      const resolveCheckpointContext = async (
        shot: (typeof shots)[number],
      ): Promise<CheckpointContext> => {
        const ctxResult: CheckpointContext = {
          baselineScreenshot: null,
          baselineSource: null,
          variationIgnoreAreas: null,
        };
        if (!shot.testVariationId) return ctxResult;

        const variationRows = await ctx.db
          .select({ ignoreRegions: testVariations.ignoreRegions })
          .from(testVariations)
          .where(eq(testVariations.id, shot.testVariationId))
          .limit(1);
        const variationIgnoreRegionsRaw =
          variationRows[0]?.ignoreRegions ?? null;
        if (
          variationIgnoreRegionsRaw &&
          Array.isArray(variationIgnoreRegionsRaw)
        ) {
          ctxResult.variationIgnoreAreas =
            variationIgnoreRegionsRaw as IgnoreRegion[];
        }

        try {
          const resolution = await resolveBaseline(
            ctx.db,
            run.projectId,
            run.branchName ?? defaultBranch,
            shot.testVariationId,
            // ADR-055: feed the parent_pr tier so the displayed baselineSource
            // matches what the diff-worker actually resolves against.
            { defaultBranch, parentPrBaseBranch: run.parentBranchName ?? null },
          );
          if (resolution) {
            ctxResult.baselineSource = resolution.source;
            const baselineRows = await ctx.db
              .select({ testRunId: baselines.testRunId })
              .from(baselines)
              .where(eq(baselines.id, resolution.baselineId))
              .limit(1);
            const baselineRunId = baselineRows[0]?.testRunId;
            if (baselineRunId) {
              // Match the baseline screenshot to the RESOLVED baseline
              // variation, not the candidate's. For a cross-branch
              // (parent_pr / default_branch) resolution the baseline lives
              // under the sibling variation on the target branch (ADR-054),
              // so its screenshots are indexed under `baselineVariationId`,
              // not the candidate's `shot.testVariationId` — keying off the
              // latter would find nothing and blank the baseline image.
              const blShots = await ctx.db
                .select()
                .from(screenshots)
                .where(
                  and(
                    eq(screenshots.runId, baselineRunId),
                    eq(
                      screenshots.testVariationId,
                      resolution.baselineVariationId,
                    ),
                  ),
                )
                .limit(1);
              ctxResult.baselineScreenshot = blShots[0] ?? null;
            }
          }
        } catch (err) {
          ctx.telemetry.logger.warn(
            { err, runId: run.id, screenshotId: shot.id },
            "baseline_screenshot_lookup_failed",
          );
        }

        return ctxResult;
      };

      const contextList = await Promise.all(
        shots.map(resolveCheckpointContext),
      );
      // Each checkpoint's review (verdict, state, decision, newer capture):
      // one batched read for the run, not one per checkpoint.
      const review = await loadCheckpointReview(ctx.db, run.id);
      const checkpointContexts: Record<
        string,
        CheckpointContext & CheckpointReviewView
      > = {};
      shots.forEach((shot, i) => {
        const c = contextList[i];
        if (c) {
          checkpointContexts[shot.id] = {
            ...c,
            ...(review.get(shot.id) ?? NO_REVIEW),
          };
        }
      });

      // Back-compat: keep the top-level fields wired to the first
      // checkpoint so existing tests + any straggler consumer keep
      // working. The dashboard reads per-checkpoint from
      // checkpointContexts based on the selected rail row.
      const firstContext = contextList[0] ?? {
        baselineScreenshot: null,
        baselineSource: null,
        variationIgnoreAreas: null,
      };

      return {
        ...run,
        ignoreAreas: runIgnoreAreas,
        screenshots: shots,
        diffRegions: regions,
        baselineScreenshot: firstContext.baselineScreenshot,
        baselineSource: firstContext.baselineSource,
        variationIgnoreAreas: firstContext.variationIgnoreAreas,
        checkpointContexts,
        autoApproved,
        prevRunId,
        nextRunId,
      };
    }),

  setComment: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        comment: z.string().max(10_000).nullable(),
      }),
    )
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const updated = await ctx.db
        .update(testRuns)
        .set({ comment: input.comment, updatedAt: new Date() })
        .where(eq(testRuns.id, input.runId))
        .returning({ id: testRuns.id, comment: testRuns.comment });
      const row = updated[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { runId: row.id, comment: row.comment };
    }),

  /**
   * Per ADR-031: persist ignore regions at run scope (`test_runs.ignore_areas`)
   * or variation scope (`test_variations.ignore_areas`), then enqueue a
   * `diff` job for the same run so the worker re-evaluates with the new
   * masks. The mutation never writes both columns.
   *
   * Regions carry a `viewport` tag so multi-viewport runs apply the right
   * mask to the right screenshot — see ADR-031 §Decision 3.
   */
  setIgnoreAreas: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        scope: z.enum(["run", "variation"]),
        ignoreAreas: z
          .array(ignoreRegionElementSchema)
          .max(MAX_IGNORE_REGIONS)
          .nullable(),
      }),
    )
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select({
          id: testRuns.id,
          projectId: testRuns.projectId,
        })
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      const payload = input.ignoreAreas === null ? null : input.ignoreAreas;

      // ADR-038: both scopes are stored at the first checkpoint's variation
      // (test_runs no longer has an ignore_areas column). The `scope` field
      // is preserved in the response for SDK back-compat but maps to the same
      // underlying storage. Phase 5 will differentiate run-scope vs.
      // variation-scope when per-checkpoint ignore regions are supported.
      const firstShot = await ctx.db
        .select({ testVariationId: screenshots.testVariationId })
        .from(screenshots)
        .where(eq(screenshots.runId, input.runId))
        .limit(1);
      if (firstShot[0]) {
        await ctx.db
          .update(testVariations)
          .set({ ignoreRegions: payload, updatedAt: new Date() })
          .where(eq(testVariations.id, firstShot[0].testVariationId));
      }

      ctx.onCommit(() =>
        ctx.diffQueue.add("diff", {
          runId: run.id,
          projectId: run.projectId,
        }),
      );

      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "testRun_updated",
        data: { id: run.id },
      });

      return {
        runId: run.id,
        scope: input.scope,
        ignoreAreas: input.ignoreAreas,
        requeued: true as const,
      };
    }),

  /**
   * Session-scoped ignore areas stored directly on the test run. Unlike
   * `setIgnoreAreas`, these are NOT persisted to the variation — they apply
   * only for this run and are cleared when the run is deleted. Callers pass
   * `null` to clear the temp ignore areas.
   *
   * Re-enqueues a diff job so the worker re-evaluates with the new masks.
   */
  setTempIgnoreAreas: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        tempIgnoreAreas: z
          .array(ignoreRegionElementSchema)
          .max(MAX_IGNORE_REGIONS)
          .nullable(),
      }),
    )
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select({
          id: testRuns.id,
          projectId: testRuns.projectId,
        })
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.db
        .update(testRuns)
        .set({
          tempIgnoreAreas: input.tempIgnoreAreas
            ? JSON.stringify(input.tempIgnoreAreas)
            : null,
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, input.runId));

      ctx.onCommit(() =>
        ctx.diffQueue.add("diff", {
          runId: run.id,
          projectId: run.projectId,
        }),
      );

      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "testRun_updated",
        data: { id: run.id },
      });

      return {
        runId: run.id,
        tempIgnoreAreas: input.tempIgnoreAreas,
        requeued: true as const,
      };
    }),

  /**
   * Append-mode counterpart to `setIgnoreAreas`. Reads the existing
   * ignore-area list for the given scope, concatenates the incoming
   * regions, and writes back. The combined list is still bounded by
   * `MAX_IGNORE_REGIONS` so a caller can't escape the cap by bursting
   * many `add` calls in a row — the check looks at `existing.length +
   * incoming.length` and rejects with `BAD_REQUEST` if it would exceed.
   *
   * Why a separate procedure (rather than a `mode: "replace" | "append"`
   * field on `setIgnoreAreas`): the existing mutation has explicit
   * "pass `null` to clear" semantics, which only makes sense in replace
   * mode. Mixing append + null-clear in one mutation would force callers
   * to reason about a three-way state (replace / append / clear) per
   * call; the predecessor frontend's API also exposed `ignoreAreas/add`
   * + `ignoreAreas/update` as two distinct endpoints, so this preserves
   * the same mental model for SDK users porting scripts.
   *
   * Like `setIgnoreAreas`, this re-enqueues a diff job so the worker
   * re-runs with the merged ignore set. SSE consumers can watch
   * `diff.completed` to know the new result has landed.
   */
  addIgnoreAreas: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        scope: z.enum(["run", "variation"]),
        // No `.nullable()` — append-mode of "append nothing" is meaningless.
        // Empty array is allowed (no-op) so idempotent retries don't error.
        ignoreAreas: z.array(ignoreRegionElementSchema).max(MAX_IGNORE_REGIONS),
      }),
    )
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select({
          id: testRuns.id,
          projectId: testRuns.projectId,
        })
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      // ADR-038: run-scope ignore areas no longer stored on test_runs.
      // Read/write from the first checkpoint's variation instead.
      const firstShot = await ctx.db
        .select({ testVariationId: screenshots.testVariationId })
        .from(screenshots)
        .where(eq(screenshots.runId, input.runId))
        .limit(1);

      let existing: IgnoreRegion[] = [];
      const variationId = firstShot[0]?.testVariationId ?? null;

      if (variationId) {
        const variationRows = await ctx.db
          .select({ ignoreRegions: testVariations.ignoreRegions })
          .from(testVariations)
          .where(eq(testVariations.id, variationId))
          .limit(1);
        const raw = variationRows[0]?.ignoreRegions ?? null;
        if (raw && Array.isArray(raw)) {
          existing = raw as IgnoreRegion[];
        }
      }

      if (existing.length + input.ignoreAreas.length > MAX_IGNORE_REGIONS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Combined ignore-area count (${existing.length + input.ignoreAreas.length}) exceeds the per-scope cap of ${MAX_IGNORE_REGIONS}. Use setIgnoreAreas to replace or delete entries first.`,
        });
      }

      const combined = [...existing, ...input.ignoreAreas];

      if (variationId) {
        await ctx.db
          .update(testVariations)
          .set({ ignoreRegions: combined, updatedAt: new Date() })
          .where(eq(testVariations.id, variationId));
      }

      ctx.onCommit(() =>
        ctx.diffQueue.add("diff", {
          runId: run.id,
          projectId: run.projectId,
        }),
      );

      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "testRun_updated",
        data: { id: run.id },
      });

      return {
        runId: run.id,
        scope: input.scope,
        added: input.ignoreAreas.length,
        total: combined.length,
        ignoreAreas: combined,
        requeued: true as const,
      };
    }),

  /**
   * Per-run override for the project's diff threshold. Pass `null` to clear
   * the override (run reverts to the project default). The mutation also
   * enqueues a `diff` job so the worker re-runs with the new threshold
   * without the user having to re-upload screenshots.
   *
   * Same shape and semantics as `setIgnoreAreas` — store-then-requeue —
   * so SSE consumers can watch `run.completed` to know the new result has
   * landed.
   */
  setDiffThresholdOverride: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        /**
         * 0-1 fraction (same units as `projects.diffThreshold`). `null`
         * clears the override → the run inherits the project default.
         * Clamp upper bound at 1 (= 100% mismatch) since values above
         * that would never trigger a failure regardless of the diff.
         */
        threshold: z.number().min(0).max(1).nullable(),
      }),
    )
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select({
          id: testRuns.id,
          projectId: testRuns.projectId,
        })
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.db
        .update(testRuns)
        .set({
          diffThresholdOverride: input.threshold,
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, input.runId));

      ctx.onCommit(() =>
        ctx.diffQueue.add("diff", {
          runId: run.id,
          projectId: run.projectId,
        }),
      );

      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "testRun_updated",
        data: { id: run.id },
      });

      return {
        runId: run.id,
        threshold: input.threshold,
        requeued: true as const,
      };
    }),

  approve: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        // ADR-036: optional reviewer-drawn ignore regions to persist onto the
        // variation as part of approval (the "draw → Save as baseline" flow).
        // Omitted by the inbox/bulk callers, which leave regions untouched.
        ignoreAreas: z
          .array(ignoreRegionElementSchema)
          .max(MAX_IGNORE_REGIONS)
          .nullable()
          .optional(),
      }),
    )
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProjectId(input, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return approveRun(
        { ...ctx, log: ctx.req.log },
        input.runId,
        input.ignoreAreas,
      );
    }),

  /**
   * Bulk-approve every reviewer-actionable run in a build, in one capped
   * transaction. Unlike a per-row client fan-out, this approves the WHOLE
   * build (not just the page of runs the dashboard happens to have loaded),
   * so "Approve all" can't silently leave later-page runs unreviewed, and a
   * mid-flight failure rolls the whole batch back instead of half-approving.
   * Each run goes through approveRunInTx, so every checkpoint is promoted.
   *
   * (The variation-wide sibling, `bulkApproveByVariation`, was removed in
   * ADR-067: it approved up to 200 reviewer-legal runs across the whole
   * project, not just runs of the seed's variations.)
   */
  bulkApproveByBuild: publicProcedure
    .input(z.object({ buildId: z.string().uuid() }))
    .use(authed)
    .use(
      projectMember<{ buildId: string }>("write", {
        from: {
          resolver: async ({
            input,
            ctx,
          }: {
            input: { buildId: string };
            ctx: Context;
          }) => {
            const rows = await ctx.db
              .select({ projectId: builds.projectId })
              .from(builds)
              .where(eq(builds.id, input.buildId))
              .limit(1);
            return rows[0]?.projectId ?? null;
          },
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const BULK_CAP = 200;
      // Only runs still awaiting a decision. `passed` is reviewer-legal for a
      // single approve, but approval itself lands runs in `passed`, so
      // including it let a capped second click re-select already-approved
      // runs instead of the rest. Oldest-first keeps each click's batch
      // stable, so repeated clicks drain the build — and when several runs
      // share a variation (retries), the newest run's baseline is written
      // last and wins (baselineWriteTime).
      const targets = await ctx.db
        .select()
        .from(testRuns)
        .where(
          and(
            eq(testRuns.buildId, input.buildId),
            inArray(testRuns.status, ["unresolved", "failed"]),
          ),
        )
        .orderBy(asc(testRuns.createdAt), asc(testRuns.id))
        .limit(BULK_CAP + 1);
      const capped = targets.length > BULK_CAP;
      const approveTargets = capped ? targets.slice(0, BULK_CAP) : targets;
      const first = approveTargets[0];
      if (!first) {
        return {
          approved: 0,
          runIds: [] as string[],
          capped: false,
          cap: BULK_CAP,
        };
      }
      const projectId = first.projectId;

      const approvedIds: string[] = [];
      let checkpoints = 0;
      await ctx.db.transaction(async (tx) => {
        for (const run of approveTargets) {
          const res = await approveRunInTx(tx, run, ctx.user.id);
          checkpoints += res.checkpointIds.length;
          approvedIds.push(run.id);
        }
      });

      for (const runId of approvedIds) {
        await ctx.broadcaster.publishProjectEvent(projectId, {
          event: "testRun_updated",
          data: { id: runId },
        });
      }
      await ctx.broadcaster.publishProjectEvent(projectId, {
        event: "build_updated",
        data: { id: input.buildId },
      });

      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "run.approve_build",
          targetType: "build",
          targetId: input.buildId,
          metadata: {
            projectId,
            approved: approvedIds.length,
            runIds: approvedIds,
            checkpoints,
            capped,
          },
        },
        ctx.req.log,
      );

      return {
        approved: approvedIds.length,
        runIds: approvedIds,
        capped,
        cap: BULK_CAP,
      };
    }),

  reject: publicProcedure
    .input(runIdInput)
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProjectId(input, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      // Per spec §3.3: same legality matrix as approve. In particular,
      // rejecting a `new` run would orphan its just-created baseline; if
      // the reviewer wants that, they need to delete the baseline directly
      // (a separate operation not introduced by this spec).
      if (!REVIEWER_LEGAL_FROM.has(run.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot reject a run with status '${run.status}'. Re-run the test instead.`,
        });
      }

      await ctx.db
        .update(testRuns)
        .set({ status: "failed", merge: false })
        .where(eq(testRuns.id, input.runId));

      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "testRun_updated",
        data: { id: run.id },
      });
      if (run.buildId) {
        await ctx.broadcaster.publishProjectEvent(run.projectId, {
          event: "build_updated",
          data: { id: run.buildId },
        });
      }

      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "run.reject",
          targetType: "run",
          targetId: run.id,
          metadata: { projectId: run.projectId, buildId: run.buildId },
        },
        ctx.req.log,
      );

      return { runId: run.id, approved: false };
    }),

  /**
   * An "Override Status" action — sets the run's status without
   * touching `merge` or `baselines`. This is the differentiator from
   * approve/reject: same status outcome (passed/failed), no baseline
   * side effect.
   *
   * Per spec §3.3 the same legality set applies — only terminal review
   * states (`passed | unresolved | failed`) are overridable.
   *
   * `"default"` recomputes the system-computed status from
   * `diff_regions`: if any row exists for this run with non-trivial
   * severity, the run becomes `unresolved`; else `passed`.
   */
  overrideStatus: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        status: overrideStatusInputSchema,
      }),
    )
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      if (!REVIEWER_LEGAL_FROM.has(run.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot override status from '${run.status}'.`,
        });
      }

      let nextStatus: "passed" | "unresolved" | "failed";
      if (input.status === "default") {
        // Recompute: any diff_regions row with severity != 'none' means
        // the system would have flagged this run as unresolved. Use a
        // LIMIT 1 short-circuit query — cheaper than COUNT(*).
        const diffRows = await ctx.db
          .select({ id: diffRegions.id })
          .from(diffRegions)
          .where(
            and(
              eq(diffRegions.runId, input.runId),
              sql`${diffRegions.severity} != 'none'`,
            ),
          )
          .limit(1);
        nextStatus = diffRows.length > 0 ? "unresolved" : "passed";
      } else {
        nextStatus = input.status;
      }

      await ctx.db
        .update(testRuns)
        .set({ status: nextStatus })
        .where(eq(testRuns.id, input.runId));

      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "testRun_updated",
        data: { id: run.id },
      });
      if (run.buildId) {
        await ctx.broadcaster.publishProjectEvent(run.projectId, {
          event: "build_updated",
          data: { id: run.buildId },
        });
      }

      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "run.override_status",
          targetType: "run",
          targetId: run.id,
          metadata: {
            projectId: run.projectId,
            buildId: run.buildId,
            from: run.status,
            to: nextStatus,
            requested: input.status,
          },
        },
        ctx.req.log,
      );

      return { runId: run.id, status: nextStatus };
    }),

  // ---------------------------------------------------------------------------
  // ADR-038: per-checkpoint approval + checkpoint listing
  // ---------------------------------------------------------------------------

  approveCheckpoint: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        checkpointId: z.string().uuid(),
        // ADR-036: optional reviewer-drawn ignore regions to persist onto the
        // checkpoint's variation, replacing the captured ones (draw → approve).
        ignoreAreas: z
          .array(ignoreRegionElementSchema)
          .max(MAX_IGNORE_REGIONS)
          .nullable()
          .optional(),
      }),
    )
    .use(authed)
    .use(
      projectMember<{ runId: string; checkpointId: string }>("write", {
        from: {
          resolver: async ({ ctx, input }) => {
            const row = await ctx.db
              .select({ projectId: testRuns.projectId })
              .from(testRuns)
              .where(eq(testRuns.id, input.runId))
              .limit(1);
            return row[0]?.projectId ?? "";
          },
        },
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(screenshots)
        .where(eq(screenshots.id, input.checkpointId))
        .limit(1);
      const s = rows[0];
      if (!s) throw new TRPCError({ code: "NOT_FOUND" });
      if (s.runId !== input.runId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "checkpoint not in run",
        });
      }
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });
      assertApprovable(run.status);

      await ctx.db.transaction(async (tx) => {
        await approveCheckpointInTx(tx, s, run, ctx.user.id, input.ignoreAreas);
      });

      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "testRun_updated",
        data: { id: run.id },
      });
      if (run.buildId) {
        await ctx.broadcaster.publishProjectEvent(run.projectId, {
          event: "build_updated",
          data: { id: run.buildId },
        });
      }

      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "run.approve_checkpoint",
          targetType: "run",
          targetId: run.id,
          metadata: {
            projectId: run.projectId,
            buildId: run.buildId,
            checkpointId: s.id,
            testVariationId: s.testVariationId,
            ignoreAreasOverride: input.ignoreAreas !== undefined,
          },
        },
        ctx.req.log,
      );

      return { checkpointId: input.checkpointId };
    }),

  approveAllCheckpoints: publicProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: {
          resolver: async ({ ctx, input }) => {
            const row = await ctx.db
              .select({ projectId: testRuns.projectId })
              .from(testRuns)
              .where(eq(testRuns.id, input.runId))
              .limit(1);
            return row[0]?.projectId ?? "";
          },
        },
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const anyShot = await ctx.db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(eq(screenshots.runId, input.runId))
        .limit(1);
      if (anyShot.length === 0) return { approved: 0 };
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });
      assertApprovable(run.status);

      const { checkpointIds } = await ctx.db.transaction((tx) =>
        approveRunInTx(tx, run, ctx.user.id),
      );

      await ctx.broadcaster.publishProjectEvent(run.projectId, {
        event: "testRun_updated",
        data: { id: run.id },
      });
      if (run.buildId) {
        await ctx.broadcaster.publishProjectEvent(run.projectId, {
          event: "build_updated",
          data: { id: run.buildId },
        });
      }

      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "run.approve_all_checkpoints",
          targetType: "run",
          targetId: run.id,
          metadata: {
            projectId: run.projectId,
            buildId: run.buildId,
            approved: checkpointIds.length,
            checkpointIds,
          },
        },
        ctx.req.log,
      );

      return { approved: checkpointIds.length };
    }),

  listCheckpoints: publicProcedure
    .input(z.object({ runId: z.string().uuid() }))
    .use(authed)
    .use(
      projectMember<{ runId: string }>("read", {
        from: {
          resolver: async ({ ctx, input }) => {
            const row = await ctx.db
              .select({ projectId: testRuns.projectId })
              .from(testRuns)
              .where(eq(testRuns.id, input.runId))
              .limit(1);
            return row[0]?.projectId ?? "";
          },
        },
      }),
    )
    .query(async ({ ctx, input }) => {
      // Per-checkpoint review (verdict, state, decision, newer capture) comes
      // from loadCheckpointReview, the read model over the decision core's own
      // rows (lib/review/reads.ts); nothing is inferred from the run's status.
      const rows = await ctx.db
        .select({
          id: screenshots.id,
          name: screenshots.name,
          viewport: screenshots.viewport,
          browser: screenshots.browser,
          os: screenshots.os,
          matchLevel: screenshots.matchLevel,
          imageKey: screenshots.imageKey,
          testVariationId: screenshots.testVariationId,
          createdAt: screenshots.createdAt,
        })
        .from(screenshots)
        .where(eq(screenshots.runId, input.runId))
        .orderBy(asc(screenshots.createdAt));

      if (rows.length === 0) return { items: [] };

      const review = await loadCheckpointReview(ctx.db, input.runId);

      const items = rows.map((r) => {
        // An entry per row unless a checkpoint was added since the first read;
        // an undiffed one reads as verdict null.
        const view = review.get(r.id) ?? NO_REVIEW;
        return {
          id: r.id,
          name: r.name,
          viewport: r.viewport,
          browser: r.browser,
          os: r.os,
          matchLevel: r.matchLevel,
          imageKey: r.imageKey,
          testVariationId: r.testVariationId,
          createdAt: r.createdAt,
          ...view,
          // Kept until the dashboard reads `state`: an alias of it
          // (approved -> passed, rejected -> failed, no verdict -> running).
          status: checkpointStatusAlias(view.state),
        };
      });
      return { items };
    }),

  /**
   * Build-scoped similarity lookup: given a checkpoint (screenshot) in a run,
   * return the other pending checkpoints in the same CI build that share the
   * same diff_signature. Used by the "Accept all N like this" button in the
   * diff-review panel (ADR-042 Phase B Step 2). "Pending" is the decision
   * core's rule (`selectPendingTargets`): a reviewable run, verdict `new` or
   * `unresolved`, no active decision.
   *
   * NULL diff_signature means VLM / auto-approved / no meaningful diff —
   * those carry no structural fingerprint, so no group can be formed.
   * Returns an empty result in that case rather than throwing.
   */
  getCheckpointGroup: publicProcedure
    .input(
      z.object({ runId: z.string().uuid(), checkpointId: z.string().uuid() }),
    )
    .use(authed)
    .use(
      projectMember<{ runId: string; checkpointId: string }>("read", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .query(async ({ ctx, input }) => {
      const seed = await loadGroupSeed(ctx.db, input);
      // VLM / auto-approved / no-meaningful-diff checkpoints carry NULL -> no group.
      const scope = groupScope(seed);
      if (scope === null) {
        return {
          checkpoints: [],
          checkpointCount: 0,
          runCount: 0,
          capped: false,
        };
      }

      // ALL pending same-signature checkpoints of the build (no window: a
      // limited one would never slide as rows get decided, stranding the
      // rest); the seed is left out and the list is capped for display.
      const { targets } = await selectPendingTargets(
        ctx.db,
        scope,
        NO_SELECTION_CAP,
      );
      const others = targets.filter(
        (t) => t.screenshotId !== input.checkpointId,
      );
      const capped = others.length > GROUP_APPROVE_CAP;
      const shownTargets = others.slice(0, GROUP_APPROVE_CAP);

      const rows =
        shownTargets.length === 0
          ? []
          : await ctx.db
              .select({
                id: screenshots.id,
                runId: screenshots.runId,
                name: screenshots.name,
                viewport: screenshots.viewport,
                testName: testRuns.name,
              })
              .from(screenshots)
              .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
              .where(
                inArray(
                  screenshots.id,
                  shownTargets.map((t) => t.screenshotId),
                ),
              );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const shown = shownTargets.flatMap((t) => byId.get(t.screenshotId) ?? []);

      return {
        checkpoints: shown.map((c) => ({
          id: c.id,
          runId: c.runId,
          testName: c.testName,
          name: c.name,
          viewport: c.viewport,
        })),
        checkpointCount: shown.length,
        runCount: new Set(shown.map((c) => c.runId)).size,
        capped,
      };
    }),

  approveCheckpointGroup: publicProcedure
    .input(
      z.object({ runId: z.string().uuid(), checkpointId: z.string().uuid() }),
    )
    .use(authed)
    .use(
      projectMember<{ runId: string; checkpointId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const seed = await loadGroupSeed(ctx.db, input);
      // NULL signature (VLM / auto-approved / no meaningful diff) -> no group.
      const scope = groupScope(seed);
      if (scope === null) {
        return {
          approved: 0,
          runCount: 0,
          capped: false,
          cap: GROUP_APPROVE_CAP,
        };
      }

      // Server RE-DERIVES the group from signature + build (never a client
      // list): the pending checkpoints of the build with the seed's signature,
      // including the seed while it is still pending, in capture order (oldest
      // run first, so a variation matched in several runs ends on the newest
      // run's baseline — written last — baselineWriteTime). The selection is
      // capped; re-running drains the rest because decided rows stop being
      // pending.
      const selected = await selectPendingTargets(
        ctx.db,
        scope,
        GROUP_APPROVE_CAP,
      );
      const capped = selected.preview.capped;

      const targets =
        selected.targets.length === 0
          ? []
          : await ctx.db
              .select({
                id: screenshots.id,
                runId: screenshots.runId,
                testVariationId: screenshots.testVariationId,
                imageKey: screenshots.imageKey,
                ignoreRegions: screenshots.ignoreRegions,
                layoutRegions: screenshots.layoutRegions,
                floatingRegions: screenshots.floatingRegions,
                contentRegions: screenshots.contentRegions,
                accessibilityRegions: screenshots.accessibilityRegions,
                matchLevel: screenshots.matchLevel,
                runName: testRuns.name,
                branchName: testRuns.branchName,
              })
              .from(screenshots)
              .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
              .where(
                inArray(
                  screenshots.id,
                  selected.targets.map((t) => t.screenshotId),
                ),
              )
              .orderBy(
                asc(testRuns.createdAt),
                asc(testRuns.id),
                asc(screenshots.createdAt),
                asc(screenshots.id),
              );

      if (targets.length === 0) {
        return {
          approved: 0,
          runCount: 0,
          capped: false,
          cap: GROUP_APPROVE_CAP,
        };
      }

      await ctx.db.transaction(async (tx) => {
        for (const m of targets) {
          await approveCheckpointInTx(
            tx,
            m,
            { id: m.runId, name: m.runName, branchName: m.branchName },
            ctx.user.id,
          );
        }
      });

      const affectedRunIds = [...new Set(targets.map((m) => m.runId))];
      for (const runId of affectedRunIds) {
        await ctx.broadcaster.publishProjectEvent(seed.projectId, {
          event: "testRun_updated",
          data: { id: runId },
        });
      }
      await ctx.broadcaster.publishProjectEvent(seed.projectId, {
        event: "build_updated",
        data: { id: seed.buildId },
      });

      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "run.approve_group",
          targetType: "build",
          targetId: seed.buildId,
          metadata: {
            projectId: seed.projectId,
            seedRunId: seed.runId,
            seedCheckpointId: seed.id,
            diffSignature: seed.diffSignature,
            approved: targets.length,
            runCount: affectedRunIds.length,
            runIds: affectedRunIds,
            checkpointIds: targets.map((m) => m.id),
            capped,
          },
        },
        ctx.req.log,
      );

      return {
        approved: targets.length,
        runCount: affectedRunIds.length,
        capped,
        cap: GROUP_APPROVE_CAP,
      };
    }),

  rejectCheckpointGroup: publicProcedure
    .input(
      z.object({ runId: z.string().uuid(), checkpointId: z.string().uuid() }),
    )
    .use(authed)
    .use(
      projectMember<{ runId: string; checkpointId: string }>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const seed = await loadGroupSeed(ctx.db, input);
      // Shared zero-result for both empty-group exits (NULL signature below +
      // zero runs with a pending member after selection).
      const empty = {
        rejected: 0,
        runCount: 0,
        capped: false,
        cap: GROUP_APPROVE_CAP,
      };
      // VLM / auto-approved / no-meaningful-diff checkpoints carry NULL -> no group.
      const scope = groupScope(seed);
      if (scope === null) return empty;

      // Same build-scoped, project-pinned, signature selection as
      // approveCheckpointGroup. Reject is RUN-level (no per-checkpoint reject
      // here), so we fail the DISTINCT runs that still have a pending member,
      // restricted to the statuses a reviewer may reject from (never `new`).
      const { targets } = await selectPendingTargets(
        ctx.db,
        scope,
        NO_SELECTION_CAP,
      );
      const pendingRunIds = [...new Set(targets.map((t) => t.runId))];
      const rejectable =
        pendingRunIds.length === 0
          ? new Set<string>()
          : new Set(
              (
                await ctx.db
                  .select({ id: testRuns.id })
                  .from(testRuns)
                  .where(
                    and(
                      inArray(testRuns.id, pendingRunIds),
                      inArray(testRuns.status, [...REVIEWER_LEGAL_FROM]),
                    ),
                  )
              ).map((r) => r.id),
            );
      const distinctRunIds = pendingRunIds.filter((id) => rejectable.has(id));
      // GROUP_APPROVE_CAP doubles as the group-action cap; reject bounds RUNS
      // (vs approve's checkpoints) since reject is run-level. A capped reject is
      // idempotent on re-run, NOT progressive: failed runs stay matchable
      // (`failed` is in REVIEWER_LEGAL_FROM) and this run-level reject records
      // no per-checkpoint decision, so their checkpoints stay pending and a
      // second "Reject all" re-targets the same first-cap runs (failed -> failed,
      // a no-op) instead of draining the next window. >cap distinct runs sharing
      // one signature in a build is pathological; the cap is a blast-radius bound.
      const capped = distinctRunIds.length > GROUP_APPROVE_CAP;
      // slice(0, CAP) already returns the whole array when length <= CAP — no ternary.
      const targetRunIds = distinctRunIds.slice(0, GROUP_APPROVE_CAP);

      if (targetRunIds.length === 0) return empty;

      // Matched checkpoints are unresolved and their runs are in
      // REVIEWER_LEGAL_FROM (filtered above), so this is one batched run-level
      // reject (a single UPDATE is atomic — no transaction needed).
      await ctx.db
        .update(testRuns)
        .set({ status: "failed", merge: false })
        .where(inArray(testRuns.id, targetRunIds));

      for (const runId of targetRunIds) {
        await ctx.broadcaster.publishProjectEvent(seed.projectId, {
          event: "testRun_updated",
          data: { id: runId },
        });
      }
      await ctx.broadcaster.publishProjectEvent(seed.projectId, {
        event: "build_updated",
        data: { id: seed.buildId },
      });

      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "run.reject_group",
          targetType: "build",
          targetId: seed.buildId,
          metadata: {
            projectId: seed.projectId,
            seedRunId: seed.runId,
            seedCheckpointId: seed.id,
            diffSignature: seed.diffSignature,
            rejected: targetRunIds.length,
            runIds: targetRunIds,
            capped,
          },
        },
        ctx.req.log,
      );

      // rejected === runCount here (run-level action); runCount retained for
      // shape-parity with approveCheckpointGroup's {approved, runCount, ...}.
      return {
        rejected: targetRunIds.length,
        runCount: targetRunIds.length,
        capped,
        cap: GROUP_APPROVE_CAP,
      };
    }),
});
