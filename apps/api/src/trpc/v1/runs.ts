import {
  and,
  asc,
  baselines,
  builds,
  count,
  desc,
  diffRegions,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  projects,
  recomputeRunStatus,
  resolveBaseline,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type RunStatus,
  type SQL,
} from "@furan/db";
import {
  overrideStatusInputSchema,
  runStatusSchema,
} from "@furan/shared-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { DiffTrigger } from "../../lib/diff-enqueue.js";
import { emitAudit } from "../../lib/emit-audit.js";
import {
  cursorTimestamp,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../../lib/keyset-cursor.js";
import {
  announceRuns,
  requireBuildProject,
  resolveBuildProject,
  trpcActionCtx,
} from "../../lib/review/actions.js";
import { queueStepDiffs, runStepIds } from "../../lib/review/enqueue.js";
import {
  GROUP_APPROVE_CAP,
  groupScope,
  loadGroupSeed,
} from "../../lib/review/groups.js";
import {
  facetCondition,
  facetValuesByBuild,
  pendingCountsByRun,
  pendingStepCondition,
  type StepFacets,
} from "../../lib/review/pending.js";
import {
  loadCheckpointReview,
  NO_REVIEW,
  type CheckpointReviewView,
} from "../../lib/review/reads.js";
import { lockRuns, selectPendingTargets } from "../../lib/review/targets.js";
import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { publicProcedure, t } from "../trpc.js";

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
   * Exact-match filters on the step environment (ADR-038: the columns live on
   * `screenshots`, not on the run). A run matches when at least one of its
   * steps does, and the facets given together must hold on the SAME step.
   * Empty string is rejected at the boundary (`.min(1)`) so the "no filter"
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
  /**
   * `true` keeps the runs that need review: at least one pending step (spec
   * §3.1; `pendingStepCondition`) inside the environment facets above.
   * `false` or omitted is no filter. Combines with `status` by AND.
   */
  pending: z.boolean().optional(),
  /**
   * `newest` (default): newest first. `capture`: oldest first, the order the
   * runs were captured, which is how a reviewer works through a batch; the
   * keyset cursor then runs ascending. Keep `order` constant while paging: a
   * cursor replayed under the other order continues from that row in the new
   * direction.
   */
  order: z.enum(["capture", "newest"]).default("newest"),
});
type ListInput = z.infer<typeof listInput>;

const facetsInput = z.object({ buildId: z.string().uuid() });
type FacetsInput = z.infer<typeof facetsInput>;

/**
 * The run statuses `overrideStatus` may act on (spec §3.3). Excludes
 * `running` (no diff outcome yet) and the terminal system states
 * `new | aborted | empty` (re-run instead of overriding). Approve and reject
 * follow the decision core's legality instead (spec §5.4).
 */
const REVIEWER_LEGAL_FROM: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "passed",
  "unresolved",
  "failed",
]);

/** `selectPendingTargets` with no cap: the caller applies its own limit. */
const NO_SELECTION_CAP = Number.MAX_SAFE_INTEGER;

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
 * The run's project, as the membership gate resolved it; NOT_FOUND when there
 * is no such run (an admin skips the gate's resolver).
 */
async function requireRunProjectId(
  input: RunIdInput,
  ctx: Context,
): Promise<string> {
  const projectId = await resolveRunProjectId(input, ctx);
  if (!projectId) throw new TRPCError({ code: "NOT_FOUND" });
  return projectId;
}

/**
 * A run as the re-diff procedures need it, locked (`FOR NO KEY UPDATE`) for
 * the rest of the request transaction; NOT_FOUND when there is no such run.
 *
 * The lock comes first, before the procedure writes a variation of the run
 * (Ruling R34): a diff commit locks run -> step -> variation, so an edit that
 * wrote the variation and then locked the run to queue its steps could
 * deadlock with it.
 */
async function loadRunForRediff(ctx: Context, runId: string) {
  const [run] = await ctx.db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      parentBranchName: testRuns.parentBranchName,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .for("no key update");
  if (!run) throw new TRPCError({ code: "NOT_FOUND" });
  return run;
}

/**
 * The variation an ignore-region write targets: the selected checkpoint's,
 * which must belong to the run (BAD_REQUEST otherwise), else the run's first
 * checkpoint (capture order `created_at, id`) for clients that don't send
 * one. Null when the run has no checkpoint (nothing to write).
 */
async function ignoreAreaVariationId(
  ctx: Context,
  runId: string,
  checkpointId: string | undefined,
): Promise<string | null> {
  if (checkpointId !== undefined) {
    const [shot] = await ctx.db
      .select({ testVariationId: screenshots.testVariationId })
      .from(screenshots)
      .where(
        and(eq(screenshots.id, checkpointId), eq(screenshots.runId, runId)),
      )
      .limit(1);
    if (!shot) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "checkpoint not in run",
      });
    }
    return shot.testVariationId;
  }
  const [first] = await ctx.db
    .select({ testVariationId: screenshots.testVariationId })
    .from(screenshots)
    .where(eq(screenshots.runId, runId))
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id))
    .limit(1);
  return first?.testVariationId ?? null;
}

/**
 * Queues every step of the run for a re-diff (`queueStepDiffs`, in the request
 * transaction; the jobs go out after commit) and tells list views it changed.
 * `trigger` is the mutation that asked for the re-diff, counted on the enqueue
 * metrics.
 */
async function rediffAndAnnounce(
  ctx: Context & { onCommit: (effect: () => unknown) => void },
  run: { id: string; projectId: string; parentBranchName: string | null },
  trigger: DiffTrigger,
): Promise<void> {
  await queueStepDiffs(ctx, run, await runStepIds(ctx.db, run), trigger);
  // No build_updated: the diff-worker fires it when the re-diff lands.
  ctx.onCommit(() =>
    ctx.broadcaster.publishProjectEvent(run.projectId, {
      event: "testRun_updated",
      data: { id: run.id },
    }),
  );
}

/** The environment facets of a `list` input, as `StepFacets`. */
function listFacets(input: StepFacets): StepFacets {
  return {
    browser: input.browser,
    viewport: input.viewport,
    os: input.os,
    device: input.device,
  };
}

/**
 * The run (`test_runs`, unaliased, in the enclosing query) has a step of the
 * project for which `step` holds. `pending.ts`'s step conditions reference the
 * unaliased `screenshots` / `test_runs`, so they go in a fresh EXISTS over
 * `screenshots`; `test_runs` binds to the enclosing list query's.
 */
function runHasStep(projectId: string, step: SQL | undefined): SQL {
  const conditions = [
    sql`${screenshots.runId} = ${testRuns.id}`,
    eq(screenshots.projectId, projectId),
  ];
  if (step) conditions.push(step);
  return exists(
    sql`(select 1 from ${screenshots} where ${and(...conditions)})`,
  );
}

/**
 * The non-status WHERE conditions `list` applies
 * (projectId + branch/buildId/customTags, plus the step conditions: the
 * environment facets and `pending`). A shared builder keeps filter logic
 * centralized so it can't drift when a dimension is added.
 */
function runListBaseConditions(
  input: {
    projectId: string;
    branch?: string | undefined;
    buildId?: string | undefined;
    customTags?: string | undefined;
    pending?: boolean | undefined;
  },
  facets: StepFacets,
) {
  const conditions = [eq(testRuns.projectId, input.projectId)];
  if (input.branch) conditions.push(eq(testRuns.branchName, input.branch));
  if (input.buildId) conditions.push(eq(testRuns.buildId, input.buildId));
  if (input.customTags) {
    // ILIKE substring against the comma-separated tag bag (SDK passes it
    // verbatim, e.g. "smoke,login,critical"); reviewers match on a substring.
    conditions.push(ilike(testRuns.customTags, `%${input.customTags}%`));
  }
  // "At least one of the run's steps matches", the facets on the same step.
  // With `pending`, that step must also be pending: pending steps count only
  // inside the facets (a pending step elsewhere does not qualify the run).
  const facetsOnly = facetCondition(facets);
  if (input.pending) {
    conditions.push(runHasStep(input.projectId, pendingStepCondition(facets)));
  } else if (facetsOnly) {
    conditions.push(runHasStep(input.projectId, facetsOnly));
  }
  return conditions;
}

/**
 * Every step of each of `runIds` (the project's runs only), unfiltered: the
 * total a reviewer sees beside the pending count. A run with no step is absent
 * from the map. One grouped query, however many runs.
 */
async function stepCountsByRun(
  db: Context["db"],
  args: { projectId: string; runIds: string[] },
): Promise<Map<string, number>> {
  if (args.runIds.length === 0) return new Map();
  const rows = await db
    .select({ id: screenshots.runId, steps: count() })
    .from(screenshots)
    .where(
      and(
        eq(screenshots.projectId, args.projectId),
        inArray(screenshots.runId, args.runIds),
      ),
    )
    .groupBy(screenshots.runId);
  return new Map(rows.map((r) => [r.id, r.steps]));
}

export const runsRouter = t.router({
  /**
   * Cursor-paginated run listing for the dashboard index page (T9) and the
   * batch page's review list.
   * Order: `created_at DESC, id DESC` (`order: "newest"`, the default) or
   * `created_at ASC, id ASC` (`order: "capture"`). The opaque cursor is the
   * last item's full-µs `created_at` + id (lib/keyset-cursor.ts); we fetch
   * `limit + 1` rows and use the extra row to decide whether `nextCursor`
   * should be set.
   *
   * Each item carries `pendingCount` (its pending steps inside the environment
   * facets) and `stepCount` (all its steps), filled by one grouped query each
   * per page.
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
      // ADR-038: browser/viewport/os/device live on screenshots; the base
      // conditions filter runs by their steps (and by pending steps).
      const facets = listFacets(input);
      const conditions = runListBaseConditions(input, facets);
      const capture = input.order === "capture";
      const cursor = input.cursor ? decodeKeysetCursor(input.cursor) : null;
      if (cursor) {
        // The keyset runs the way the list does: after the cursor row.
        const keyset = sql`(${testRuns.createdAt}, ${testRuns.id})`;
        const cursorKey = sql`(${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
        conditions.push(
          capture
            ? sql`${keyset} > ${cursorKey}`
            : sql`${keyset} < ${cursorKey}`,
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
        .orderBy(
          ...(capture
            ? [asc(testRuns.createdAt), asc(testRuns.id)]
            : [desc(testRuns.createdAt), desc(testRuns.id)]),
        )
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      // One grouped query each for the whole page, never one per row.
      const runIds = page.map((r) => r.run.id);
      const pendingByRun = await pendingCountsByRun(ctx.db, {
        projectId: input.projectId,
        runIds,
        facets,
      });
      const stepsByRun = await stepCountsByRun(ctx.db, {
        projectId: input.projectId,
        runIds,
      });
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
        pendingCount: pendingByRun.get(r.run.id) ?? 0,
        stepCount: stepsByRun.get(r.run.id) ?? 0,
      }));
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeKeysetCursor({ createdAt: last.cursorAt, id: last.run.id })
          : null;
      return { items, nextCursor };
    }),

  /**
   * The environment values (browser, viewport, os, device) the batch's steps
   * have, each with its pending steps: what the batch page's environment filter
   * offers. Resolve-then-gate on the build's project (a bare `buildId`), like
   * `builds.getById`.
   */
  facets: publicProcedure
    .input(facetsInput)
    .use(authed)
    .use(
      projectMember<FacetsInput>("read", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveBuildProject(ctx.db, input.buildId),
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      // An admin skips the gate's resolver: resolve the project again here.
      const projectId = await requireBuildProject(ctx.db, input.buildId);
      return facetValuesByBuild(ctx.db, { projectId, buildId: input.buildId });
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
      const review = await loadCheckpointReview(ctx.db, run.id, ctx.user);
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
   * Per ADR-031: persist ignore regions onto a checkpoint's variation
   * (`test_variations.ignore_regions`), then enqueue a `diff` job for the same
   * run so the worker re-evaluates with the new masks.
   *
   * The regions go to `checkpointId`'s variation (the checkpoint the reviewer
   * drew on; it must be in the run), else to the run's first checkpoint for
   * clients that don't send one (spec §5.7). `scope` is kept in the response
   * for SDK back-compat; both scopes write the variation (ADR-038).
   *
   * Regions carry a `viewport` tag so multi-viewport runs apply the right
   * mask to the right screenshot — see ADR-031 §Decision 3.
   */
  setIgnoreAreas: publicProcedure
    .input(
      z.object({
        runId: z.string().uuid(),
        scope: z.enum(["run", "variation"]),
        checkpointId: z.string().uuid().optional(),
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
      const run = await loadRunForRediff(ctx, input.runId);
      const variationId = await ignoreAreaVariationId(
        ctx,
        run.id,
        input.checkpointId,
      );
      if (variationId) {
        await ctx.db
          .update(testVariations)
          .set({ ignoreRegions: input.ignoreAreas, updatedAt: new Date() })
          .where(eq(testVariations.id, variationId));
      }

      await rediffAndAnnounce(ctx, run, "ignore_areas");

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
      const run = await loadRunForRediff(ctx, input.runId);

      await ctx.db
        .update(testRuns)
        .set({
          tempIgnoreAreas: input.tempIgnoreAreas
            ? JSON.stringify(input.tempIgnoreAreas)
            : null,
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, run.id));

      await rediffAndAnnounce(ctx, run, "temp_ignore_areas");

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
        /** The checkpoint whose variation gets the regions (see setIgnoreAreas). */
        checkpointId: z.string().uuid().optional(),
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
      const run = await loadRunForRediff(ctx, input.runId);
      // The selected checkpoint's variation, else the run's first (ADR-038:
      // ignore areas live on the variation, not on test_runs).
      const variationId = await ignoreAreaVariationId(
        ctx,
        run.id,
        input.checkpointId,
      );

      let existing: IgnoreRegion[] = [];
      if (variationId) {
        // Locked for the read-modify-write, so a concurrent approve's region
        // merge (which locks the variation too) is not overwritten.
        const variationRows = await ctx.db
          .select({ ignoreRegions: testVariations.ignoreRegions })
          .from(testVariations)
          .where(eq(testVariations.id, variationId))
          .for("no key update");
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

      await rediffAndAnnounce(ctx, run, "ignore_areas");

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
      const run = await loadRunForRediff(ctx, input.runId);

      await ctx.db
        .update(testRuns)
        .set({
          diffThresholdOverride: input.threshold,
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, run.id));

      await rediffAndAnnounce(ctx, run, "threshold");

      return {
        runId: run.id,
        threshold: input.threshold,
        requeued: true as const,
      };
    }),

  /**
   * "Force passed / Force failed / Reset to computed" (ADR-070): writes the
   * run's `status_override` (`"default"` clears it), then recomputes the
   * status with `recomputeRunStatus`, where an override wins over the
   * checkpoints' rollup. No baseline is touched. An override survives any
   * re-diff, and while it is set the run's checkpoints are not reviewable
   * (`run_overridden`) until it is reset.
   *
   * Per spec §3.3 only terminal review states (`passed | unresolved |
   * failed`) are overridable. That status is read under the run's row lock,
   * which is held through the write and the recompute (R21).
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
      const actx = trpcActionCtx(ctx);
      const projectId = await requireRunProjectId(input, ctx);
      // Lock the run (R8) BEFORE reading the status the legality gate checks
      // (R21): a concurrent revert or re-diff that makes the run `running`
      // either commits first (and the gate sees it) or waits for this one.
      const [run] = (
        await lockRuns(actx.tx, projectId, [input.runId])
      ).values();
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      if (!REVIEWER_LEGAL_FROM.has(run.lifecycle)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot override status from '${run.lifecycle}'.`,
        });
      }

      await ctx.db
        .update(testRuns)
        .set({
          statusOverride: input.status === "default" ? null : input.status,
          updatedAt: new Date(),
        })
        .where(eq(testRuns.id, run.id));
      const { after } = await recomputeRunStatus(actx.tx, run.id);

      await announceRuns(actx, run.projectId, [run.id]);

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
            from: run.lifecycle,
            to: after,
            requested: input.status,
          },
        },
        ctx.req.log,
      );

      return { runId: run.id, status: after };
    }),

  // ---------------------------------------------------------------------------
  // ADR-038: checkpoint listing and the group lookup (the decisions themselves
  // are `review.*`)
  // ---------------------------------------------------------------------------

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
          device: screenshots.device,
          matchLevel: screenshots.matchLevel,
          imageKey: screenshots.imageKey,
          testVariationId: screenshots.testVariationId,
          createdAt: screenshots.createdAt,
        })
        .from(screenshots)
        .where(eq(screenshots.runId, input.runId))
        .orderBy(asc(screenshots.createdAt));

      if (rows.length === 0) return { items: [] };

      const review = await loadCheckpointReview(ctx.db, input.runId, ctx.user);

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
          device: r.device,
          matchLevel: r.matchLevel,
          imageKey: r.imageKey,
          testVariationId: r.testVariationId,
          createdAt: r.createdAt,
          ...view,
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
      const projectId = await requireRunProjectId(input, ctx);
      const seed = await loadGroupSeed(ctx.db, input, projectId);
      // VLM / auto-approved / no-meaningful-diff checkpoints carry NULL -> no group.
      const scope = groupScope(seed, projectId);
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
});
