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
  lt,
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

import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

import {
  approveCheckpointInTx,
  deriveCheckpointStatuses,
  GROUP_APPROVE_CAP,
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
 * mode) share the same validation rules — Applitools-aligned kinds, regex
 * pattern requirement for dynamic-text, thresholdOverride only on strict.
 *
 * Caller-facing units stay in image-pixel space (matching screenshot
 * dimensions); the worker re-applies viewport filtering at diff time.
 */
const ignoreRegionElementSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    viewport: z.string().min(1).max(32),
    paddingPx: z.number().int().min(0).max(32).default(0),
    /**
     * Match mode (Applitools-aligned):
     * - `ignore`: skip the region entirely (mask in L1, ignored in L2).
     * - `dynamic-text`: mask in L1 only when OCR'd text matches `pattern`.
     * - `strict`: don't mask; region is informational. When
     *   `thresholdOverride` is set, the engine will (TODO) apply that
     *   tighter threshold locally. Until the engine work lands, strict
     *   regions are pure metadata — useful as visual review markers
     *   ("this area MUST match"). See furan-design/specs/2026-05-23-region-modes-design.md.
     * - `layout`: mask the region in L1 (suppresses pixel diff inside).
     *   v1 ships the masking + visual marker; L2-side layout-only
     *   classification is engine work tracked in the same design doc.
     * - `content`: same v1 behavior as layout — mask in L1, stored as a
     *   distinct kind so the future L2 text-content compare wires up
     *   without a wire-shape change.
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
const MAX_IGNORE_REGIONS = 50;

const listInput = z.object({
  projectId: z.string().uuid(),
  cursor: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  /** Exact-match filter on `test_runs.branch_name`. */
  branch: z.string().min(1).max(255).optional(),
  /**
   * Multi-select filter on `test_runs.status`. Each element is narrowed to
   * the typed `runStatusSchema` enum (the seven Applitools-aligned values)
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
 * Input for `statusCounts` — the non-status filters that `list` actually
 * applies (branch, customTags, buildId). Status itself is intentionally
 * absent: the counts describe how many runs fall in each status given the
 * other filters, which is exactly what the chip labels need.
 */
const statusCountsInput = z.object({
  projectId: z.string().uuid(),
  branch: z.string().optional(),
  buildId: z.string().uuid().optional(),
  customTags: z.string().optional(),
});
type StatusCountsInput = z.infer<typeof statusCountsInput>;

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
 * Approve a single test run: transitions status → passed, sets merge=true,
 * snapshots into baselines, and publishes broadcaster events. Shared by
 * `runs.approve` and `inbox.approve` so both callers apply identical side
 * effects without duplicating logic.
 *
 * Throws TRPCError NOT_FOUND if the run doesn't exist, BAD_REQUEST if its
 * status isn't in REVIEWER_LEGAL_FROM.
 */
export async function approveRun(
  ctx: {
    db: import("@furan/db").DB;
    broadcaster: import("../../lib/broadcast.js").Broadcaster;
    user: { id: string };
  },
  runId: string,
): Promise<{ runId: string; approved: true }> {
  const runRows = await ctx.db
    .select()
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) throw new TRPCError({ code: "NOT_FOUND" });

  // Per spec §3.3 + ADR-036: review terminal states plus `new`
  // (first-baseline when autoApproveFeature=false). Reject mid-flight
  // (`running`) and other system states (`aborted`, `empty`) — for
  // those the right response is to re-run.
  if (!APPROVE_LEGAL_FROM.has(run.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot approve a run with status '${run.status}'. Re-run the test instead.`,
    });
  }

  await ctx.db
    .update(testRuns)
    .set({ status: "passed", merge: true })
    .where(eq(testRuns.id, runId));

  // ADR-038: runs no longer have a single testVariationId. Snapshot the
  // first checkpoint's variation as the baseline for backward compat.
  // Full per-checkpoint baseline promotion is handled by approveCheckpoint.
  // For legacy approve (run-level), we find the first screenshot row and
  // use its testVariationId.
  const firstShot = await ctx.db
    .select({
      testVariationId: screenshots.testVariationId,
      imageKey: screenshots.imageKey,
    })
    .from(screenshots)
    .where(eq(screenshots.runId, runId))
    .limit(1);

  if (firstShot[0]) {
    await ctx.db.insert(baselines).values({
      baselineName: firstShot[0].imageKey ?? run.name ?? "auto",
      testVariationId: firstShot[0].testVariationId,
      testRunId: run.id,
      userId: ctx.user.id,
      ...(run.branchName ? { branchName: run.branchName } : {}),
    });
  } else {
    // No screenshots yet — insert a placeholder baseline using run name.
    // This branch handles legacy flow where runs might not have checkpoints.
    // We skip the baseline insert rather than fail — approve still transitions status.
  }

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
 * The non-status WHERE conditions both `list` and `statusCounts` apply
 * (projectId + branch/buildId/customTags). Sharing one builder keeps the chip
 * counts and the listed rows describing the same population, so they can't
 * drift when a filter dimension is added (e.g. ADR-038 Phase 5 device filters).
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
   * Order: `desc(created_at)`. Cursor is the `created_at` (ISO string) of
   * the last item from the previous page; we fetch `limit + 1` rows and use
   * the extra row to decide whether `nextCursor` should be set.
   */
  list: t.procedure
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
      // `list` and `statusCounts` in lockstep.
      const conditions = runListBaseConditions(input);
      if (input.cursor) {
        conditions.push(lt(testRuns.createdAt, new Date(input.cursor)));
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
        })
        .from(testRuns)
        .leftJoin(builds, eq(testRuns.buildId, builds.id))
        .where(and(...conditions))
        .orderBy(desc(testRuns.createdAt))
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
        hasMore && last ? last.run.createdAt.toISOString() : null;
      return { items, nextCursor };
    }),

  /**
   * Per-status run counts for the index page's filter chips. Mirrors the
   * non-status filters `list` actually applies (branch, customTags, buildId)
   * so a chip's count matches what selecting it would show. One cheap GROUP
   * BY — unaffected by the list's cursor pagination.
   */
  statusCounts: t.procedure
    .input(statusCountsInput)
    .use(authed)
    .use(
      projectMember<StatusCountsInput>("read", {
        from: {
          resolver: ({ input }: { input: StatusCountsInput; ctx: Context }) =>
            Promise.resolve(input.projectId),
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const conditions = runListBaseConditions(input);
      const rows = await ctx.db
        .select({
          status: testRuns.status,
          count: sql<number>`count(*)::int`,
        })
        .from(testRuns)
        .where(and(...conditions))
        .groupBy(testRuns.status);
      const counts: Partial<Record<RunStatus, number>> = {};
      let total = 0;
      for (const r of rows) {
        counts[r.status] = r.count;
        total += r.count;
      }
      return { total, counts };
    }),

  getById: t.procedure
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
            { defaultBranch },
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
              // Match the baseline screenshot to the candidate by
              // variation, not by "first row in the baseline run". A
              // baseline run with multiple checkpoints would otherwise
              // hand back the wrong image when the candidate isn't
              // index 0 of the baseline run either.
              const blShots = await ctx.db
                .select()
                .from(screenshots)
                .where(
                  and(
                    eq(screenshots.runId, baselineRunId),
                    eq(screenshots.testVariationId, shot.testVariationId),
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
      const checkpointContexts: Record<string, CheckpointContext> = {};
      shots.forEach((shot, i) => {
        const c = contextList[i];
        if (c) checkpointContexts[shot.id] = c;
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

  setComment: t.procedure
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
  setIgnoreAreas: t.procedure
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

      await ctx.diffQueue.add("diff", {
        runId: run.id,
        projectId: run.projectId,
      });

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
  setTempIgnoreAreas: t.procedure
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

      await ctx.diffQueue.add("diff", {
        runId: run.id,
        projectId: run.projectId,
      });

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
  addIgnoreAreas: t.procedure
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

      await ctx.diffQueue.add("diff", {
        runId: run.id,
        projectId: run.projectId,
      });

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
  setDiffThresholdOverride: t.procedure
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

      await ctx.diffQueue.add("diff", {
        runId: run.id,
        projectId: run.projectId,
      });

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

  approve: t.procedure
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
      return approveRun(ctx, input.runId);
    }),

  /**
   * Bulk-approve every reviewer-actionable run that shares the same test
   * variation as the supplied `runId`. Same per-run side effects as
   * `approve` (status → passed, merge → true, snapshot into `baselines`),
   * but applied in a single transaction so the user doesn't end up half
   * approved if a row fails.
   *
   * Scope choice: variation-wide (not build-wide). Reviewers ask for this
   * when they've decided "this candidate looks right for this test
   * everywhere it appeared," which often spans multiple builds (re-runs,
   * branch fan-out). The procedure caps at 200 rows to keep the
   * transaction bounded; the toast surfaces if we hit the cap so the user
   * knows to re-trigger.
   *
   * Pre-condition: the supplied runId must itself be reviewer-actionable
   * (passed | unresolved | failed). The bulk operation can include runs
   * already in `passed` — those are idempotently re-approved (baseline
   * row inserted, status unchanged), which matches the existing single
   * `approve` behavior.
   */
  bulkApproveByVariation: t.procedure
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
      const seedRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const seed = seedRows[0];
      if (!seed) throw new TRPCError({ code: "NOT_FOUND" });
      if (!REVIEWER_LEGAL_FROM.has(seed.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot bulk-approve from a '${seed.status}' run. Re-run the test instead.`,
        });
      }

      // ADR-038: runs no longer have a single testVariationId. Bulk approve
      // operates on runs in the same build/project in reviewer-legal states.
      // Phase 5 will add per-variation bulk approve for the new model.
      const BULK_CAP = 200;
      const siblings = await ctx.db
        .select()
        .from(testRuns)
        .where(
          and(
            eq(testRuns.projectId, seed.projectId),
            inArray(testRuns.status, [...REVIEWER_LEGAL_FROM]),
          ),
        )
        .limit(BULK_CAP + 1);
      const capped = siblings.length > BULK_CAP;
      const approveTargets = capped ? siblings.slice(0, BULK_CAP) : siblings;

      // Same row-level side effects as the per-run approve, looped. A
      // single transaction prevents a partial outcome on an unexpected
      // constraint violation; if any row fails, the user retries with a
      // clean state.
      const approvedIds: string[] = [];
      const affectedBuildIds = new Set<string>();
      await ctx.db.transaction(async (tx) => {
        for (const run of approveTargets) {
          await tx
            .update(testRuns)
            .set({ status: "passed", merge: true })
            .where(eq(testRuns.id, run.id));
          // ADR-038: find first checkpoint variation for baseline insertion.
          const firstShot = await tx
            .select({
              testVariationId: screenshots.testVariationId,
              imageKey: screenshots.imageKey,
            })
            .from(screenshots)
            .where(eq(screenshots.runId, run.id))
            .limit(1);
          if (firstShot[0]) {
            await tx.insert(baselines).values({
              baselineName: firstShot[0].imageKey ?? run.name ?? "auto",
              testVariationId: firstShot[0].testVariationId,
              testRunId: run.id,
              userId: ctx.user.id,
              ...(run.branchName ? { branchName: run.branchName } : {}),
            });
          }
          approvedIds.push(run.id);
          if (run.buildId) affectedBuildIds.add(run.buildId);
        }
      });

      // Subscribers debounce per event-type, so per-row broadcasts coalesce
      // into one flush. Deduping build_updated keeps the post-tx loop O(B)
      // not O(N*B) when many runs share a build.
      for (const runId of approvedIds) {
        await ctx.broadcaster.publishProjectEvent(seed.projectId, {
          event: "testRun_updated",
          data: { id: runId },
        });
      }
      for (const buildId of affectedBuildIds) {
        await ctx.broadcaster.publishProjectEvent(seed.projectId, {
          event: "build_updated",
          data: { id: buildId },
        });
      }

      return {
        approved: approvedIds.length,
        runIds: approvedIds,
        capped,
        cap: BULK_CAP,
      };
    }),

  /**
   * Bulk-approve every reviewer-actionable run in a build, in one capped
   * transaction. Unlike a per-row client fan-out, this approves the WHOLE
   * build (not just the page of runs the dashboard happens to have loaded),
   * so "Approve all" can't silently leave later-page runs unreviewed, and a
   * mid-flight failure rolls the whole batch back instead of half-approving.
   */
  bulkApproveByBuild: t.procedure
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
      const targets = await ctx.db
        .select()
        .from(testRuns)
        .where(
          and(
            eq(testRuns.buildId, input.buildId),
            inArray(testRuns.status, [...REVIEWER_LEGAL_FROM]),
          ),
        )
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
      await ctx.db.transaction(async (tx) => {
        for (const run of approveTargets) {
          await tx
            .update(testRuns)
            .set({ status: "passed", merge: true })
            .where(eq(testRuns.id, run.id));
          const firstShot = await tx
            .select({
              testVariationId: screenshots.testVariationId,
              imageKey: screenshots.imageKey,
            })
            .from(screenshots)
            .where(eq(screenshots.runId, run.id))
            .limit(1);
          if (firstShot[0]) {
            await tx.insert(baselines).values({
              baselineName: firstShot[0].imageKey ?? run.name ?? "auto",
              testVariationId: firstShot[0].testVariationId,
              testRunId: run.id,
              userId: ctx.user.id,
              ...(run.branchName ? { branchName: run.branchName } : {}),
            });
          }
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

      return {
        approved: approvedIds.length,
        runIds: approvedIds,
        capped,
        cap: BULK_CAP,
      };
    }),

  reject: t.procedure
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

      return { runId: run.id, approved: false };
    }),

  /**
   * Applitools-style "Override Status" — sets the run's status without
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
  overrideStatus: t.procedure
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

      return { runId: run.id, status: nextStatus };
    }),

  // ---------------------------------------------------------------------------
  // ADR-038: per-checkpoint approval + checkpoint listing
  // ---------------------------------------------------------------------------

  approveCheckpoint: t.procedure
    .input(
      z.object({ runId: z.string().uuid(), checkpointId: z.string().uuid() }),
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

      await ctx.db.transaction(async (tx) => {
        await approveCheckpointInTx(tx, s, run, ctx.user.id);
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

      return { checkpointId: input.checkpointId };
    }),

  approveAllCheckpoints: t.procedure
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
      const rows = await ctx.db
        .select()
        .from(screenshots)
        .where(eq(screenshots.runId, input.runId));
      if (rows.length === 0) return { approved: 0 };
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.db.transaction(async (tx) => {
        for (const s of rows) {
          await approveCheckpointInTx(tx, s, run, ctx.user.id);
        }
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

      return { approved: rows.length };
    }),

  listCheckpoints: t.procedure
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
      // Per-checkpoint status comes from deriveCheckpointStatuses — the single
      // source of truth for the new/unresolved/passed predicate (checkpoint-grouping.ts).
      const rows = await ctx.db
        .select({
          id: screenshots.id,
          name: screenshots.name,
          viewport: screenshots.viewport,
          browser: screenshots.browser,
          matchLevel: screenshots.matchLevel,
          imageKey: screenshots.imageKey,
          testVariationId: screenshots.testVariationId,
          createdAt: screenshots.createdAt,
          baselineName: testVariations.baselineName,
        })
        .from(screenshots)
        .leftJoin(
          testVariations,
          eq(testVariations.id, screenshots.testVariationId),
        )
        .where(eq(screenshots.runId, input.runId))
        .orderBy(asc(screenshots.createdAt));

      if (rows.length === 0) return { items: [] };

      const statuses = await deriveCheckpointStatuses(
        ctx.db,
        rows.map((r) => ({
          id: r.id,
          runId: input.runId,
          viewport: r.viewport,
          baselineName: r.baselineName,
        })),
      );

      const items = rows.map((r) => ({
        id: r.id,
        name: r.name,
        viewport: r.viewport,
        browser: r.browser,
        matchLevel: r.matchLevel,
        imageKey: r.imageKey,
        testVariationId: r.testVariationId,
        createdAt: r.createdAt,
        // statuses always has an entry per row; ?? is a defensive fallback.
        status: statuses.get(r.id) ?? "passed",
      }));
      return { items };
    }),

  /**
   * Build-scoped similarity lookup: given a checkpoint (screenshot) in a run,
   * return the other unresolved checkpoints in the same CI build that share
   * the same diff_signature. Used by the "Accept all N like this" button in
   * the diff-review panel (ADR-042 Phase B Step 2).
   *
   * NULL diff_signature means VLM / auto-approved / no meaningful diff —
   * those carry no structural fingerprint, so no group can be formed.
   * Returns an empty result in that case rather than throwing.
   */
  getCheckpointGroup: t.procedure
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
      const seedRows = await ctx.db
        .select({
          id: screenshots.id,
          runId: screenshots.runId,
          diffSignature: screenshots.diffSignature,
          buildId: testRuns.buildId,
          projectId: testRuns.projectId,
        })
        .from(screenshots)
        .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
        .where(eq(screenshots.id, input.checkpointId))
        .limit(1);
      const seed = seedRows[0];
      if (!seed) throw new TRPCError({ code: "NOT_FOUND" });
      if (seed.runId !== input.runId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "checkpoint not in run",
        });
      }
      // VLM / auto-approved / no-meaningful-diff checkpoints carry NULL -> no group.
      if (seed.diffSignature === null) {
        return {
          checkpoints: [],
          checkpointCount: 0,
          runCount: 0,
          capped: false,
        };
      }

      // Fetch ALL same-signature checkpoints in the build (the diff_signature index keeps this targeted); the unresolved set is filtered in-app and capped for display. No SQL limit — a limited window would never slide as rows get approved, stranding the rest.
      const candidates = await ctx.db
        .select({
          id: screenshots.id,
          runId: screenshots.runId,
          name: screenshots.name,
          viewport: screenshots.viewport,
          testName: testRuns.name,
          baselineName: testVariations.baselineName,
        })
        .from(screenshots)
        .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
        .innerJoin(
          testVariations,
          eq(testVariations.id, screenshots.testVariationId),
        )
        .where(
          and(
            eq(testRuns.buildId, seed.buildId),
            // Defense-in-depth: pin to the seed's project (a build should never span projects; this guards against a corrupt build↔project state).
            eq(testRuns.projectId, seed.projectId),
            eq(screenshots.diffSignature, seed.diffSignature),
          ),
        )
        .orderBy(asc(screenshots.createdAt));

      const others = candidates.filter((c) => c.id !== input.checkpointId);
      const statuses = await deriveCheckpointStatuses(ctx.db, others);
      const unresolved = others.filter(
        (c) => statuses.get(c.id) === "unresolved",
      );
      const capped = unresolved.length > GROUP_APPROVE_CAP;
      const shown = unresolved.slice(0, GROUP_APPROVE_CAP);

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

  approveCheckpointGroup: t.procedure
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
      const seedRows = await ctx.db
        .select({
          id: screenshots.id,
          runId: screenshots.runId,
          diffSignature: screenshots.diffSignature,
          buildId: testRuns.buildId,
          projectId: testRuns.projectId,
        })
        .from(screenshots)
        .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
        .where(eq(screenshots.id, input.checkpointId))
        .limit(1);
      const seed = seedRows[0];
      if (!seed) throw new TRPCError({ code: "NOT_FOUND" });
      if (seed.runId !== input.runId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "checkpoint not in run",
        });
      }
      // NULL signature (VLM / auto-approved / no meaningful diff) -> no group.
      if (seed.diffSignature === null) {
        return {
          approved: 0,
          runCount: 0,
          capped: false,
          cap: GROUP_APPROVE_CAP,
        };
      }

      // Server RE-DERIVES the group from signature + build (never a client list).
      // Includes the seed when it is still unresolved. Build-scoped hard boundary.
      // Fetch ALL same-signature matches in the build (no SQL limit — a limited window never slides, so re-running "Accept all" would strand rows beyond it). Filter unresolved in-app, cap the APPROVED set; re-running drains the rest because approved rows drop out of the unresolved filter.
      const matches = await ctx.db
        .select({
          id: screenshots.id,
          runId: screenshots.runId,
          viewport: screenshots.viewport,
          testVariationId: screenshots.testVariationId,
          imageKey: screenshots.imageKey,
          ignoreRegions: screenshots.ignoreRegions,
          layoutRegions: screenshots.layoutRegions,
          floatingRegions: screenshots.floatingRegions,
          contentRegions: screenshots.contentRegions,
          accessibilityRegions: screenshots.accessibilityRegions,
          matchLevel: screenshots.matchLevel,
          baselineName: testVariations.baselineName,
          runName: testRuns.name,
          branchName: testRuns.branchName,
        })
        .from(screenshots)
        .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
        .innerJoin(
          testVariations,
          eq(testVariations.id, screenshots.testVariationId),
        )
        .where(
          and(
            eq(testRuns.buildId, seed.buildId),
            eq(testRuns.projectId, seed.projectId),
            eq(screenshots.diffSignature, seed.diffSignature),
          ),
        )
        .orderBy(asc(screenshots.createdAt));

      const statuses = await deriveCheckpointStatuses(ctx.db, matches);
      const unresolved = matches.filter(
        (m) => statuses.get(m.id) === "unresolved",
      );
      const capped = unresolved.length > GROUP_APPROVE_CAP;
      const targets = capped
        ? unresolved.slice(0, GROUP_APPROVE_CAP)
        : unresolved;

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

      return {
        approved: targets.length,
        runCount: affectedRunIds.length,
        capped,
        cap: GROUP_APPROVE_CAP,
      };
    }),

  rejectCheckpointGroup: t.procedure
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
      const seedRows = await ctx.db
        .select({
          id: screenshots.id,
          runId: screenshots.runId,
          diffSignature: screenshots.diffSignature,
          buildId: testRuns.buildId,
          projectId: testRuns.projectId,
        })
        .from(screenshots)
        .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
        .where(eq(screenshots.id, input.checkpointId))
        .limit(1);
      const seed = seedRows[0];
      if (!seed) throw new TRPCError({ code: "NOT_FOUND" });
      if (seed.runId !== input.runId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "checkpoint not in run",
        });
      }
      if (seed.diffSignature === null) {
        return {
          rejected: 0,
          runCount: 0,
          capped: false,
          cap: GROUP_APPROVE_CAP,
        };
      }

      // Same build-scoped, project-guarded, signature derivation as
      // approveCheckpointGroup. Reject is RUN-level (no per-checkpoint reject),
      // so we fail the DISTINCT runs of the matched still-unresolved checkpoints.
      const matches = await ctx.db
        .select({
          id: screenshots.id,
          runId: screenshots.runId,
          viewport: screenshots.viewport,
          baselineName: testVariations.baselineName,
        })
        .from(screenshots)
        .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
        .innerJoin(
          testVariations,
          eq(testVariations.id, screenshots.testVariationId),
        )
        .where(
          and(
            eq(testRuns.buildId, seed.buildId),
            eq(testRuns.projectId, seed.projectId),
            eq(screenshots.diffSignature, seed.diffSignature),
            inArray(testRuns.status, [...REVIEWER_LEGAL_FROM]),
          ),
        )
        .orderBy(asc(screenshots.createdAt));

      const statuses = await deriveCheckpointStatuses(ctx.db, matches);
      const unresolved = matches.filter(
        (m) => statuses.get(m.id) === "unresolved",
      );
      const distinctRunIds = [...new Set(unresolved.map((m) => m.runId))];
      // GROUP_APPROVE_CAP doubles as the group-action cap; reject bounds RUNS
      // (vs approve's checkpoints) since reject is run-level.
      const capped = distinctRunIds.length > GROUP_APPROVE_CAP;
      const targetRunIds = capped
        ? distinctRunIds.slice(0, GROUP_APPROVE_CAP)
        : distinctRunIds;

      if (targetRunIds.length === 0) {
        return {
          rejected: 0,
          runCount: 0,
          capped: false,
          cap: GROUP_APPROVE_CAP,
        };
      }

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
