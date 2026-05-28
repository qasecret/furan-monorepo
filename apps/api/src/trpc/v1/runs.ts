import {
  and,
  asc,
  baselines,
  desc,
  diffRegions,
  eq,
  gt,
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

  // Per spec §3.3: only terminal review states can be approved. Reject
  // mid-flight (`running`) and terminal system states (`new`, `aborted`,
  // `empty`) — for those the right response is to re-run, not override.
  if (!REVIEWER_LEGAL_FROM.has(run.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot approve a run with status '${run.status}'. Re-run the test instead.`,
    });
  }

  await ctx.db
    .update(testRuns)
    .set({ status: "passed", merge: true })
    .where(eq(testRuns.id, runId));

  // Snapshot the approved run into baselines (branch-scoped, §4.7).
  await ctx.db.insert(baselines).values({
    baselineName: run.baselineName ?? run.name ?? "auto",
    testVariationId: run.testVariationId,
    testRunId: run.id,
    userId: ctx.user.id,
    ...(run.branchName ? { branchName: run.branchName } : {}),
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
      const conditions = [eq(testRuns.projectId, input.projectId)];
      if (input.cursor) {
        conditions.push(lt(testRuns.createdAt, new Date(input.cursor)));
      }
      if (input.branch) {
        conditions.push(eq(testRuns.branchName, input.branch));
      }
      if (input.buildId) {
        conditions.push(eq(testRuns.buildId, input.buildId));
      }
      // Empty array == no filter, identical to undefined — keeps the
      // dashboard's "all checkboxes off" state simple and avoids an
      // accidental `status IN ()` that would return zero rows.
      if (input.status && input.status.length > 0) {
        conditions.push(inArray(testRuns.status, input.status));
      }
      if (input.browser) {
        conditions.push(eq(testRuns.browser, input.browser));
      }
      if (input.viewport) {
        conditions.push(eq(testRuns.viewport, input.viewport));
      }
      if (input.os) {
        conditions.push(eq(testRuns.os, input.os));
      }
      if (input.device) {
        conditions.push(eq(testRuns.device, input.device));
      }
      if (input.customTags) {
        // ILIKE substring against the comma-separated bag. Matches the
        // legacy semantics where customTags is a free-form string the
        // SDK passes through verbatim (e.g. "smoke,login,critical") and
        // reviewers want to find any run tagged with one substring.
        conditions.push(ilike(testRuns.customTags, `%${input.customTags}%`));
      }

      const rows = await ctx.db
        .select()
        .from(testRuns)
        .where(and(...conditions))
        .orderBy(desc(testRuns.createdAt))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;
      return { items, nextCursor };
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

      // Fetch the variation's ignore areas for the diff viewer's region editor.
      // Returned as a parsed array; null when the column is unset or malformed.
      const variationRows = await ctx.db
        .select({ ignoreAreas: testVariations.ignoreAreas })
        .from(testVariations)
        .where(eq(testVariations.id, run.testVariationId))
        .limit(1);
      const variationIgnoreAreasRaw = variationRows[0]?.ignoreAreas ?? null;
      let variationIgnoreAreas: IgnoreRegion[] | null = null;
      if (variationIgnoreAreasRaw) {
        try {
          const parsed = JSON.parse(variationIgnoreAreasRaw);
          if (Array.isArray(parsed)) {
            variationIgnoreAreas = parsed as IgnoreRegion[];
          }
        } catch {
          // malformed JSON → treat as null
        }
      }

      // Parse run-level ignore areas; override the raw JSON string from ...run.
      // Returned as a parsed array; null when the column is unset or malformed.
      let runIgnoreAreas: IgnoreRegion[] | null = null;
      if (run.ignoreAreas) {
        try {
          const parsed = JSON.parse(run.ignoreAreas);
          if (Array.isArray(parsed)) {
            runIgnoreAreas = parsed as IgnoreRegion[];
          }
        } catch {
          // malformed JSON → treat as null
        }
      }

      // Sibling runs of the same variation, ordered by created_at.
      // prevRunId = the run immediately OLDER than this one (ArrowLeft goes
      // back in time); nextRunId = the run immediately NEWER (ArrowRight).
      // Each query is bounded to 1 row via .limit(1); both hit the
      // (test_variation_id, created_at) index path so they're cheap.
      const prevRun = await ctx.db
        .select({ id: testRuns.id })
        .from(testRuns)
        .where(
          and(
            eq(testRuns.testVariationId, run.testVariationId),
            lt(testRuns.createdAt, run.createdAt),
          ),
        )
        .orderBy(desc(testRuns.createdAt))
        .limit(1);

      const nextRun = await ctx.db
        .select({ id: testRuns.id })
        .from(testRuns)
        .where(
          and(
            eq(testRuns.testVariationId, run.testVariationId),
            gt(testRuns.createdAt, run.createdAt),
          ),
        )
        .orderBy(asc(testRuns.createdAt)) // ASC — closest newer
        .limit(1);

      const prevRunId = prevRun[0]?.id ?? null;
      const nextRunId = nextRun[0]?.id ?? null;

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

      // Resolve the baseline screenshot for the BASELINE pane of the viewer.
      // T9: dashboard side-by-side / overlay / onion-skin all need the
      // baseline's screenshot row (its imageKey). Reuse the three-tier
      // resolver from @furan/db so we stay consistent with the diff worker.
      let baselineScreenshot: (typeof shots)[number] | null = null;
      let baselineSource: string | null = null;
      try {
        const projectRows = await ctx.db
          .select({ mainBranchName: projects.mainBranchName })
          .from(projects)
          .where(eq(projects.id, run.projectId))
          .limit(1);
        const defaultBranch = projectRows[0]?.mainBranchName ?? "main";

        const resolution = await resolveBaseline(
          ctx.db,
          run.projectId,
          run.branchName ?? defaultBranch,
          run.testVariationId,
          { defaultBranch },
        );

        if (resolution) {
          baselineSource = resolution.source;
          const baselineRows = await ctx.db
            .select({ testRunId: baselines.testRunId })
            .from(baselines)
            .where(eq(baselines.id, resolution.baselineId))
            .limit(1);
          const baselineRunId = baselineRows[0]?.testRunId;
          if (baselineRunId) {
            const blShots = await ctx.db
              .select()
              .from(screenshots)
              .where(eq(screenshots.runId, baselineRunId));
            baselineScreenshot = blShots[0] ?? null;
          }
        }
      } catch (err) {
        // Baseline resolution is informational; don't fail getById on it.
        ctx.telemetry.logger.warn(
          { err, runId: run.id },
          "baseline_screenshot_lookup_failed",
        );
      }

      return {
        ...run,
        ignoreAreas: runIgnoreAreas, // override the raw JSON string spread from ...run
        screenshots: shots,
        diffRegions: regions,
        baselineScreenshot,
        baselineSource,
        variationIgnoreAreas,
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
          testVariationId: testRuns.testVariationId,
        })
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      const payload =
        input.ignoreAreas === null ? null : JSON.stringify(input.ignoreAreas);

      if (input.scope === "run") {
        await ctx.db
          .update(testRuns)
          .set({ ignoreAreas: payload, updatedAt: new Date() })
          .where(eq(testRuns.id, input.runId));
      } else {
        await ctx.db
          .update(testVariations)
          .set({ ignoreAreas: payload, updatedAt: new Date() })
          .where(eq(testVariations.id, run.testVariationId));
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
          testVariationId: testRuns.testVariationId,
          ignoreAreas: testRuns.ignoreAreas,
        })
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      // Read existing for the requested scope.
      let existing: IgnoreRegion[] = [];
      if (input.scope === "run") {
        if (run.ignoreAreas) {
          try {
            const parsed = JSON.parse(run.ignoreAreas);
            if (Array.isArray(parsed)) existing = parsed as IgnoreRegion[];
          } catch {
            // Malformed stored payload — treat as empty rather than 500.
            // The new write replaces it with a well-formed array.
          }
        }
      } else {
        const variationRows = await ctx.db
          .select({ ignoreAreas: testVariations.ignoreAreas })
          .from(testVariations)
          .where(eq(testVariations.id, run.testVariationId))
          .limit(1);
        const raw = variationRows[0]?.ignoreAreas ?? null;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) existing = parsed as IgnoreRegion[];
          } catch {
            // Same as run-scope above.
          }
        }
      }

      if (existing.length + input.ignoreAreas.length > MAX_IGNORE_REGIONS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Combined ignore-area count (${existing.length + input.ignoreAreas.length}) exceeds the per-scope cap of ${MAX_IGNORE_REGIONS}. Use setIgnoreAreas to replace or delete entries first.`,
        });
      }

      const combined = [...existing, ...input.ignoreAreas];
      const payload = JSON.stringify(combined);

      if (input.scope === "run") {
        await ctx.db
          .update(testRuns)
          .set({ ignoreAreas: payload, updatedAt: new Date() })
          .where(eq(testRuns.id, input.runId));
      } else {
        await ctx.db
          .update(testVariations)
          .set({ ignoreAreas: payload, updatedAt: new Date() })
          .where(eq(testVariations.id, run.testVariationId));
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

      // Find every other run of the same variation in a reviewer-legal
      // state. Bounded to 200 to keep the transaction cheap and rule out
      // pathological multi-thousand-row variations.
      const BULK_CAP = 200;
      const siblings = await ctx.db
        .select()
        .from(testRuns)
        .where(
          and(
            eq(testRuns.testVariationId, seed.testVariationId),
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
          await tx.insert(baselines).values({
            baselineName: run.baselineName ?? run.name ?? "auto",
            testVariationId: run.testVariationId,
            testRunId: run.id,
            userId: ctx.user.id,
            ...(run.branchName ? { branchName: run.branchName } : {}),
          });
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
});
