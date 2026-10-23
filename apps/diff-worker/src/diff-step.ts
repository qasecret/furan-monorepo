import {
  and,
  baselines,
  desc,
  eq,
  screenshots,
  type BaselineSource,
  type CheckpointVerdict,
  type DB,
  type projects,
  type testRuns,
} from "@furan/db";
import {
  runAxe,
  runDiff,
  runL1,
  runVlm,
  classifyRegions,
  computeCheckpointSignature,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_VLM_CONFIG,
  configForMatchLevel,
  ollamaProvider,
  geminiProvider,
  anthropicProvider,
  type MatchLevel,
  type VlmProvider,
  type VlmProviderConfig,
} from "@furan/diff-engine";
import { evaluateCompiled } from "@furan/rules-engine";
import type {
  CompiledRuleset,
  DiffRegion as RulesDiffRegion,
  ElementMap as RulesElementMap,
  EvaluationDiagnostics,
  EvaluationResult,
  RegionDecision,
} from "@furan/rules-engine";
import { objectKey, type Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import sharp from "sharp";

import { resolveAxeBboxes } from "./axe-bbox-resolver.js";
import { resolveCheckpointBaseline } from "./checkpoint-baseline.js";
import { evaluateDynamicTextRegions } from "./dynamic-text.js";
import {
  fetchElementMap,
  resolveRegionBbox,
  type ElementMap,
} from "./element-map-resolver.js";
import { parseEngineConfig, redactSecret } from "./engine-config.js";
import type { HandlerDeps, ParsedIgnoreArea } from "./handler.js";
import { classifyLayoutClusters } from "./layout-suppression.js";
import { resolveRuleSelectorElementMap } from "./rule-selector-resolver.js";
import { checkpointFailures, regionEngineId } from "./rules-aggregation.js";
import { strictBreaches, type StrictRegionInput } from "./strict-tolerance.js";

function resolveVlmProvider(config: VlmProviderConfig): VlmProvider {
  const provider = config.provider ?? "ollama";
  switch (provider) {
    case "gemini":
      return geminiProvider;
    case "anthropic":
      return anthropicProvider;
    case "ollama":
    default:
      return ollamaProvider;
  }
}

type Logger = Telemetry["logger"];
type ProjectRow = typeof projects.$inferSelect;
type RunRow = typeof testRuns.$inferSelect;
type ScreenshotRow = typeof screenshots.$inferSelect;

/**
 * What one step's diff reads besides the step itself. Loaded once per job
 * (`loadStepContext` in handler.ts) and shared by every step the job diffs:
 * read-only except the per-job element-map cache.
 */
export interface StepContext {
  deps: HandlerDeps;
  logger: Logger;
  project: ProjectRow;
  run: RunRow;
  /**
   * Per-run override (set via the in-viewer sensitivity slider) wins over the
   * project default: `run.diffThresholdOverride ?? project.diffThreshold`.
   */
  diffThreshold: number;
  /** The run's temp ignore regions (ADR-031); they apply to every step. */
  tempIgnoreAreas: ParsedIgnoreArea[];
  /** Each step variation's ignore regions, by variation id. */
  variationIgnore: Map<string, ParsedIgnoreArea[]>;
  /**
   * The project's enabled auto rules, compiled once per job (spec
   * 2026-10-23 §4). Null when it has none, or when they failed to load
   * (fail-open).
   */
  compiledRules: CompiledRuleset | null;
  /**
   * The distinct CSS selectors of those rules. They drive each step's
   * element-map resolution (the candidate DOM is only in scope there). Taken
   * from the rule rows: a compiled rule no longer carries its selector.
   */
  ruleSelectors: string[];
  /**
   * Per-job cache shared across steps. Avoids refetching the same
   * element-map sidecar when multiple steps of the same job carry the same
   * `elementMapKey` (rare) or when a single step's regions all resolve
   * against the same map (the common case).
   */
  elementMapCache: Map<string, ElementMap | null>;
  parentPrBaseBranch?: string | null;
}

/** One diff region of a step, tagged with the step it was detected on. */
export interface InflatedRegion {
  severity: string;
  category: string;
  bbox: unknown;
  description: string;
  source: string;
  viewport: string | null;
  screenshotId: string;
}

/**
 * A dynamic-text OCR decision (matched OR unmatched), persisted as a synthetic
 * audit row in `diff_regions`. `source="dynamic_text"` + `ocr_text` /
 * `ocr_matched` distinguish these from real diff regions; severity is always
 * "none" so they're hidden from the default RegionListPanel view.
 */
export interface OcrAuditRow {
  screenshotId: string;
  severity: string;
  category: string;
  bbox: { x: number; y: number; width: number; height: number };
  description: string;
  source: string;
  viewport: string | null;
  ocrText: string | null;
  ocrMatched: boolean;
}

/**
 * Auto-approved (ADR-032 hash match, past-baseline match, or first-capture
 * auto-seed under `autoApproveFeature`): the step becomes its variation's
 * baseline with a NULL user, unless `autoApproveBaselineBlock` keeps the one
 * there.
 */
export interface AutoApproveDecision {
  strategy: "hash" | "past-baseline" | "first-capture";
  /**
   * The run the step's paired baseline belongs to, for the auto-approve
   * baseline guard; null for a first capture (nothing was paired).
   */
  pairedBaselineRunId: string | null;
}

/**
 * One candidate screenshot (checkpoint, step) after its own baseline was
 * resolved, paired and diffed (spec §3), and its own regions were run through
 * the auto rules (spec 2026-10-23 §4).
 */
export interface StepResult {
  /** The candidate screenshot this result is for. */
  screenshotId: string;
  /**
   * Spec §3: no baseline image → `new`; otherwise `unresolved` if it still
   * fails after rules, else `passed`.
   */
  verdict: CheckpointVerdict;
  /**
   * No baseline image to diff against: none resolved in any tier, or the
   * resolved baseline's screenshot is missing. Verdict `new`, no regions.
   */
  firstBaseline: boolean;
  regions: InflatedRegion[];
  /** `regionEngineId(0, i)` per region: the ids `ruleDecisions` refer to. */
  engineIds: string[];
  ranTiers: Array<"l1">;
  /** ADR-042: the checkpoint's diff signature; null when it was not diffed or
   * had no meaningful regions. */
  diffSignature: string | null;
  /** The step's own diff image; null when the diff produced none, or it was
   * not diffed. */
  diffImageKey: string | null;
  /** Null when there was no baseline image (verdict `new`); 0 when it was
   * auto-approved without a diff. */
  diffPercent: number | null;
  /** Null and 0 exactly as `diffPercent`. */
  pixelMismatchCount: number | null;
  /** Tier the checkpoint's baseline resolved from; null when none did. */
  baselineSource: BaselineSource | null;
  vlmDescription: string | null;
  /** At least one of the step's regions was auto-approved by a rule. */
  ruleResolved: boolean;
  autoApprove: AutoApproveDecision | null;
  ocrAudit: OcrAuditRow[];
  /** The rules' decision per region (ids from `engineIds`); empty when the
   * step was not evaluated. */
  ruleDecisions: RegionDecision[];
  /** The step's rule evaluation, for the job's rule metrics; null when it
   * was not evaluated (no rules, no diff, or the evaluation failed). */
  ruleDiagnostics: EvaluationDiagnostics | null;
}

/** A checkpoint that is not diffed: first capture, missing pair, or auto-approved. */
function undiffedStep(
  cs: { id: string },
  outcome: Pick<StepResult, "firstBaseline" | "autoApprove" | "baselineSource">,
): StepResult {
  // No baseline image → `new`; an auto-approved step passed without a diff.
  // Only a step that was compared has a diff % (0 here).
  const compared = outcome.firstBaseline ? null : 0;
  return {
    screenshotId: cs.id,
    verdict: outcome.firstBaseline ? "new" : "passed",
    diffPercent: compared,
    pixelMismatchCount: compared,
    diffImageKey: null,
    regions: [],
    engineIds: [],
    ranTiers: [],
    diffSignature: null,
    vlmDescription: null,
    ruleResolved: false,
    ocrAudit: [],
    ruleDecisions: [],
    ruleDiagnostics: null,
    ...outcome,
  };
}

async function tryAutoApproveByPastBaselines(
  db: DB,
  storage: Storage,
  variationId: string,
  candidateImageKey: string,
  diffThreshold: number,
  logger: Logger,
): Promise<boolean> {
  const pastBaselines = await db
    .select({
      testRunId: baselines.testRunId,
      testVariationId: baselines.testVariationId,
    })
    .from(baselines)
    .where(eq(baselines.testVariationId, variationId))
    // resolveBaseline's order, so [0] is the current baseline skipped below.
    .orderBy(desc(baselines.createdAt), desc(baselines.id))
    .limit(10);

  if (pastBaselines.length <= 1) return false;

  const candidateBytes = await storage.get(candidateImageKey);
  if (!candidateBytes) return false;

  for (const bl of pastBaselines.slice(1)) {
    try {
      // The past baseline's own image: its run's screenshot OF THIS VARIATION.
      // A run holds one screenshot per checkpoint, so pairing by run alone
      // would compare against an arbitrary sibling checkpoint.
      const blScreenshot = await db
        .select({ imageKey: screenshots.imageKey })
        .from(screenshots)
        .where(
          and(
            eq(screenshots.runId, bl.testRunId),
            eq(screenshots.testVariationId, bl.testVariationId),
          ),
        )
        .orderBy(desc(screenshots.createdAt), desc(screenshots.id))
        .limit(1);
      if (!blScreenshot[0]?.imageKey) continue;

      const blBytes = await storage.get(blScreenshot[0].imageKey);
      if (!blBytes) continue;

      const l1 = await runL1(
        Buffer.from(blBytes),
        Buffer.from(candidateBytes),
        undefined,
        "odiff",
        DEFAULT_ENGINE_CONFIG,
      );
      if (l1.diffPercent <= diffThreshold * 100) {
        logger.info(
          { variationId, matchedBaselineRunId: bl.testRunId },
          "auto-approve: candidate matches past baseline",
        );
        return true;
      }
    } catch (err) {
      // A past-baseline comparison failing (e.g. its image is missing from
      // storage) shouldn't abort auto-approve — skip that baseline. But log
      // it: a silent skip could otherwise hide systemic storage/compare
      // failures behind a run that just "didn't auto-approve".
      logger.warn(
        { err, variationId, baselineRunId: bl.testRunId },
        "auto_approve_baseline_compare_failed",
      );
      continue;
    }
  }
  return false;
}

/**
 * Auto Rules for ONE step (spec 2026-10-23 §4): its own regions, ids
 * `regionEngineId(0, i)`, against the rules the job compiled. Null when the
 * job has no rules, or when this step's evaluation throws: fail-open, the
 * rules are then absent for this step only.
 */
function evaluateStepRules(
  ctx: StepContext,
  cs: ScreenshotRow,
  regions: InflatedRegion[],
  engineIds: string[],
  diffPercent: number,
  ruleElementMap: RulesElementMap,
): EvaluationResult | null {
  const { compiledRules } = ctx;
  if (!compiledRules) return null;
  if (regions.length === 0) {
    return {
      decisions: [],
      counts: { auto_approve: 0, flag: 0, unmatched: 0 },
      diagnostics: {
        evaluatedRules: 0,
        matchedRules: 0,
        skippedBecauseNoElementMap: 0,
        selectorMisses: 0,
        durationMs: 0,
      },
    };
  }

  try {
    const ruleRegions: RulesDiffRegion[] = regions.map((r, i) => ({
      id: engineIds[i]!,
      severity: r.severity,
      category: r.category,
      bbox: r.bbox as {
        x: number;
        y: number;
        width: number;
        height: number;
      },
      description: r.description ?? "",
      source: r.source,
      // NOTE: this is the viewport-level diff %, not a per-region value
      // (the engine does not yet emit per-region diff). The maxDiff
      // condition therefore compares against the whole-viewport diff.
      // Revisit when per-region diff % is available.
      diffPercent,
    }));

    // evaluateCompiled is synchronous CPU work (no I/O).
    return evaluateCompiled({
      diffRegions: ruleRegions,
      // Selectors resolved against this checkpoint's DOM + element-map; empty
      // when the SDK shipped no DOM/map sidecar.
      elementMap: ruleElementMap,
      ruleset: compiledRules,
    });
  } catch (err) {
    ctx.logger.error(
      {
        err,
        runId: ctx.run.id,
        projectId: ctx.project.id,
        screenshotId: cs.id,
      },
      "rules-engine evaluation failed; proceeding without rule decisions",
    );
    ctx.deps.metrics?.rulesEvaluationErrors.inc();
    return null;
  }
}

/**
 * One step's diff (spec 2026-10-23 §4.2): the old whole-run loop body, for
 * one candidate screenshot (checkpoint) `cs`:
 *   1. resolves the checkpoint's own baseline via the three-tier
 *      `resolveBaseline` chain on its variation, and pairs it with the
 *      baseline run's screenshot OF THAT VARIATION (`checkpoint-baseline.ts`);
 *   2. no baseline, or a missing pair → verdict `new` (a first capture is
 *      auto-seeded as its variation's baseline under `autoApproveFeature`);
 *   3. hash or past-baseline match under `autoApproveFeature` (ADR-032) →
 *      verdict `passed` and the checkpoint becomes its variation's baseline;
 *   4. otherwise runs the image diff masked by its variation's ignore regions
 *      plus the run's temp regions → `passed` or `unresolved` after the auto
 *      rules, evaluated on this step's regions only.
 *
 * It writes no result to the database (the caller commits the `StepResult`)
 * and reads nothing of the run's other steps. Its only write is the
 * content-addressed diff image to storage.
 */
export async function diffStep(
  ctx: StepContext,
  cs: ScreenshotRow,
): Promise<StepResult> {
  const { deps, logger, project, run, diffThreshold } = ctx;
  // The caller checks this before any step; a step never resolves a
  // baseline without a branch.
  if (!run.branchName) {
    throw new Error(`run_missing_branch_name:${run.id}`);
  }
  const viewportKey = cs.viewport ?? null;

  // 1. Resolve this checkpoint's own baseline (three-tier chain on ITS
  //    variation) and pair it with that baseline's exact image.
  const pairing = await resolveCheckpointBaseline(deps.db, {
    projectId: project.id,
    branchName: run.branchName,
    testVariationId: cs.testVariationId,
    defaultBranch: project.mainBranchName,
    parentPrBaseBranch: ctx.parentPrBaseBranch ?? null,
  });

  // 2. No baseline image → verdict `new`, no diff.
  //    - none: a first capture. With `autoApproveFeature` (ADR-036) it is
  //      auto-seeded as its variation's baseline (NULL user); otherwise the
  //      reviewer saves it. Either way the verdict stays `new`.
  //    - pair_missing: a baseline resolved but its run holds no screenshot of
  //      its variation (data drift). Never diffed against another
  //      checkpoint's image, and never auto-seeded over the real baseline.
  if (pairing.kind !== "paired") {
    if (pairing.kind === "pair_missing") {
      deps.metrics?.baselinePairMissing.inc();
      logger.warn(
        {
          project_id: project.id,
          run_id: run.id,
          screenshot_id: cs.id,
          variation_id: cs.testVariationId,
          baseline_id: pairing.baselineId,
        },
        "diff_baseline_pair_missing",
      );
    } else {
      logger.info(
        { runId: run.id, screenshotId: cs.id, viewport: viewportKey },
        "diff_checkpoint_no_baseline",
      );
    }
    return undiffedStep(cs, {
      firstBaseline: true,
      autoApprove:
        pairing.kind === "none" && project.autoApproveFeature === true
          ? { strategy: "first-capture", pairedBaselineRunId: null }
          : null,
      baselineSource: pairing.kind === "pair_missing" ? pairing.source : null,
    });
  }
  const baselineShot = pairing.baselineShot;

  // 3. Auto-approve, per checkpoint (ADR-032): this checkpoint's image hash
  //    equals its paired baseline's, or it matches one of its variation's
  //    recent past baselines. Short-circuits the engine; the checkpoint
  //    passes and becomes its variation's baseline (NULL user).
  if (project.autoApproveFeature) {
    let strategy: "hash" | "past-baseline" | null = null;
    if (cs.imageKey === baselineShot.imageKey) {
      strategy = "hash";
    } else if (
      await tryAutoApproveByPastBaselines(
        deps.db,
        deps.storage,
        cs.testVariationId,
        cs.imageKey,
        diffThreshold,
        logger,
      )
    ) {
      strategy = "past-baseline";
    }
    if (strategy !== null) {
      logger.info(
        {
          runId: run.id,
          projectId: project.id,
          screenshotId: cs.id,
          strategy,
        },
        "diff_checkpoint_auto_approved",
      );
      return undiffedStep(cs, {
        firstBaseline: false,
        // The run the paired baseline belongs to, for the auto-approve
        // baseline guard in the core transaction.
        autoApprove: { strategy, pairedBaselineRunId: pairing.baselineRunId },
        baselineSource: pairing.source,
      });
    }
  }

  // 4. Engine diff against the paired image, masked by THIS checkpoint's
  //    variation regions plus the run's temp regions.
  const allRegions = dedupeRegions([
    ...(ctx.variationIgnore.get(cs.testVariationId) ?? []),
    ...ctx.tempIgnoreAreas,
  ]);

  const baselineBytes = await deps.storage.get(baselineShot.imageKey);
  const candidateBytes = await deps.storage.get(cs.imageKey);
  const candidateDom = cs.domKey
    ? new TextDecoder().decode(await deps.storage.get(cs.domKey))
    : undefined;

  const candidateMeta = await sharp(Buffer.from(candidateBytes)).metadata();
  const bounds = {
    width: candidateMeta.width ?? 0,
    height: candidateMeta.height ?? 0,
  };

  // Dynamic-text regions: OCR the candidate crop, evaluate the regex,
  // and only inject matched regions into the mask. Unmatched regions
  // fall through to L1 (catching real visual diffs). Skipped entirely
  // when the project doesn't have the feature flag on — tesseract.js
  // stays unloaded.
  const dynamicTextResults = project.dynamicTextEnabled
    ? await evaluateDynamicTextRegions(
        Buffer.from(candidateBytes),
        allRegions,
        logger,
      )
    : [];
  const matchedIndexes = new Set(
    dynamicTextResults.filter((r) => r.matched).map((r) => r.regionIndex),
  );
  for (const dtr of dynamicTextResults) {
    deps.metrics?.dynamicTextMatch
      .labels({
        outcome:
          dtr.ocrText === null
            ? "ocr_failed"
            : dtr.matched
              ? "matched"
              : "unmatched",
      })
      .inc();
  }
  // Per-step dynamic-text OCR audit: one synthetic audit row per
  // (checkpoint, region) pair.
  const ocrAudit: OcrAuditRow[] = dynamicTextResults.map((dt) => {
    const r = allRegions[dt.regionIndex]!;
    const preview = (dt.ocrText ?? "").slice(0, 80);
    return {
      screenshotId: cs.id,
      severity: "none",
      category: "text",
      bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
      description: dt.matched
        ? `Dynamic text matched: "${preview}"`
        : `Dynamic text did NOT match: "${preview}"`,
      source: "dynamic_text",
      viewport: cs.viewport ?? null,
      ocrText: dt.ocrText,
      ocrMatched: dt.matched,
    };
  });

  // Resolve any selector-anchored regions against the candidate's
  // element-map sidecar. Best-effort: every failure path returns the
  // stored bbox. The per-job cache is shared across viewports.
  const resolvedIgnoreAreas = await Promise.all(
    allRegions
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => {
        // cs.viewport null (legacy v0.4 row) → ?? makes equality self-referential
        // → all tagged regions apply, matching the no-viewport-tag legacy compat.
        if (r.viewport && r.viewport !== (cs.viewport ?? r.viewport))
          return false;
        // Per-region mask dispatch — see
        // furan-design/specs/2026-05-23-region-modes-design.md.
        //
        // strict: never masked. The region is a constraint ("must
        // match here"), not an exclusion. Per-region tolerance
        // (`thresholdOverride`) is captured on the wire but the
        // engine doesn't yet honor it — until then, strict is pure
        // metadata.
        //
        // layout + content: behave like `ignore` at L1 — mask the
        // pixel diff inside the bbox (ADR-047). Storing distinct kinds
        // means the wire shape correctly reflects the reviewer's intent
        // without a separate diff pass. Strict breaches are
        // post-filtered via `strictBreaches` below.
        //
        // dynamic-text: existing behavior — mask only when OCR
        // matched. Unmatched dynamic-text regions fall through to L1.
        //
        // ignore (default): always mask.
        if (r.kind === "strict") return false;
        if (r.kind === "dynamic-text") return matchedIndexes.has(i);
        return true;
      })
      .map(async ({ r }) => {
        const resolved = await resolveRegionBbox(
          r,
          cs.elementMapKey ?? null,
          bounds,
          ctx.elementMapCache,
          {
            storage: deps.storage,
            logger,
            onOutcome: (outcome) =>
              deps.metrics?.regionResolution.labels({ outcome }).inc(),
          },
        );
        return inflateRegion(
          {
            x: resolved.x,
            y: resolved.y,
            width: resolved.width,
            height: resolved.height,
            paddingPx: r.paddingPx,
          },
          bounds,
        );
      }),
  );

  // Image-first (ADR-047): matchLevel no longer routes tiers — every value
  // maps to the single image compare. We still read the stored per-screenshot
  // matchLevel (fallback "Strict" for legacy rows) and pass it through for
  // back-compat, but configForMatchLevel now returns the base engine config
  // unchanged.
  const screenshotMatchLevel = (cs.matchLevel as MatchLevel) ?? "Strict";
  const baseEngineConfig = parseEngineConfig(
    project.imageComparisonConfig,
    logger,
    project.id,
  );
  const routedEngineConfig = configForMatchLevel(
    baseEngineConfig,
    screenshotMatchLevel,
  );

  let result: Awaited<ReturnType<typeof runDiff>>;
  let vlmDescription: string | undefined;
  if (project.imageComparison === "vlm") {
    const vlmConfigJson = project.imageComparisonConfig;
    let vlmConfig: VlmProviderConfig;
    try {
      vlmConfig = vlmConfigJson
        ? JSON.parse(vlmConfigJson)
        : DEFAULT_VLM_CONFIG;
    } catch {
      vlmConfig = DEFAULT_VLM_CONFIG;
    }
    const t0 = performance.now();
    const vlmResult = await runVlm(
      Buffer.from(baselineBytes),
      Buffer.from(candidateBytes),
      {
        provider: resolveVlmProvider(vlmConfig),
        config: vlmConfig,
        engineConfig: routedEngineConfig,
        diffThreshold,
        ignoreAreas: resolvedIgnoreAreas,
      },
    );
    result = {
      passed: vlmResult.passed,
      diffPercent: vlmResult.diffPercent,
      pixelMismatchCount: vlmResult.pixelMismatchCount,
      diffImageBytes: vlmResult.diffImageBytes,
      regions: [],
      ranTiers: ["l1"],
      durationMs: { l1: performance.now() - t0 },
    };
    // A provider SDK error can echo request details; never let the
    // project's API key reach the persisted description or the logs.
    const apiKey = (vlmConfig as { apiKey?: unknown }).apiKey;
    vlmDescription =
      vlmResult.vlmDescription === undefined
        ? undefined
        : redactSecret(vlmResult.vlmDescription, apiKey);
    if (vlmResult.vlmError) {
      // The VLM layer fell back to the L1 verdict — surface it as a metric
      // + warn so a provider outage is alertable, not just buried in the
      // persisted description.
      deps.metrics?.vlmFailures
        .labels({ reason: vlmResult.vlmError.reason })
        .inc();
      logger.warn(
        {
          runId: run.id,
          projectId: project.id,
          reason: vlmResult.vlmError.reason,
          detail: redactSecret(vlmResult.vlmError.message, apiKey),
        },
        "vlm_fallback_to_l1",
      );
    }
  } else {
    result = await runDiff({
      baseline: {
        image: Buffer.from(baselineBytes),
      },
      candidate: {
        image: Buffer.from(candidateBytes),
      },
      ignoreDisplacements: cs.ignoreDisplacements,
      l1DisplacementMetric: {
        labels: (l) => ({
          inc: () => deps.metrics?.l1Displacement.labels(l).inc(),
        }),
      },
      config: {
        // Per-run override (set via the in-viewer sensitivity slider) wins
        // over the project default. Null/undefined means "inherit," so the
        // existing project setting still drives every run that hasn't been
        // tuned by hand.
        diffThreshold,
        ignoreAreas: resolvedIgnoreAreas,
        engine: project.imageComparison,
        // Engine config (matchLevel no longer adjusts it — ADR-047).
        engineConfig: routedEngineConfig,
      },
    });
  }

  // Tier 2.5: when the checkpoint opted into
  // accessibility validation (cs.accessibilityLevel set), run
  // axe-core against the captured DOM HTML and append the
  // violations to the result regions before classification +
  // persistence. WCAG-version defaults to 2.1 when only the level
  // is set (so callers can opt in with just a level).
  if (cs.accessibilityLevel && candidateDom !== undefined) {
    try {
      const axeRegions = await runAxe(candidateDom, {
        level: cs.accessibilityLevel as "AA" | "AAA",
        version:
          (cs.accessibilityVersion as "WCAG_2_0" | "WCAG_2_1" | null) ??
          "WCAG_2_1",
      });
      result.regions = [...result.regions, ...classifyRegions(axeRegions)];
    } catch (err) {
      logger.warn(
        { err, screenshotId: cs.id, level: cs.accessibilityLevel },
        "axe_core_run_failed",
      );
    }
  } else if (cs.accessibilityLevel && candidateDom === undefined) {
    logger.warn(
      { screenshotId: cs.id, level: cs.accessibilityLevel },
      "accessibility_check_requested_but_no_dom_payload",
    );
  }

  // --- Region modes v2 engine pipeline (after L1, before persist) ---
  //
  // Fetch the candidate element-map sidecar. Used by resolveAxeBboxes (axe
  // violation bbox localization) and resolveRegionBbox (reviewer Layout/Content
  // region resolution). Best-effort: missing map leaves bbox: {0,0,0,0} for axe
  // regions; the dashboard handles that by showing the violation in the side
  // panel only.
  const elementMapKey = cs.elementMapKey ?? null;
  let elementMap: ElementMap | null = null;
  if (elementMapKey) {
    const cached = ctx.elementMapCache.get(elementMapKey);
    if (cached !== undefined) {
      elementMap = cached;
    } else {
      elementMap = await fetchElementMap(elementMapKey, {
        storage: deps.storage,
        logger,
        onOutcome: (outcome) =>
          deps.metrics?.regionResolution.labels({ outcome }).inc(),
      });
      ctx.elementMapCache.set(elementMapKey, elementMap);
    }
  }
  // ADR-053: for the Layout match level, also fetch the BASELINE element map
  // so the layout pass can compare each element's geometry across
  // baseline↔candidate. Gated on Layout to avoid a wasted storage GET on
  // Strict checkpoints. Shares the per-job elementMapCache (distinct keys).
  let baselineElementMap: ElementMap | null = null;
  if (screenshotMatchLevel === "Layout") {
    const baselineElementMapKey = baselineShot.elementMapKey ?? null;
    if (baselineElementMapKey) {
      const cachedBaseline = ctx.elementMapCache.get(baselineElementMapKey);
      if (cachedBaseline !== undefined) {
        baselineElementMap = cachedBaseline;
      } else {
        baselineElementMap = await fetchElementMap(baselineElementMapKey, {
          storage: deps.storage,
          logger,
          onOutcome: (outcome) =>
            deps.metrics?.regionResolution.labels({ outcome }).inc(),
        });
        ctx.elementMapCache.set(baselineElementMapKey, baselineElementMap);
      }
    }
  }
  // Tier 2.5 close-out: resolve axe violation bboxes via the candidate DOM +
  // element-map sidecar. Mutates any source='axe' regions already appended to
  // result.regions in the Tier 2.5 block above. Misses leave bbox:{0,0,0,0};
  // the dashboard already handles those by showing the violation in the side
  // panel only.
  resolveAxeBboxes(result.regions, candidateDom, elementMap, {
    axeResolution: {
      labels: (l) => ({
        inc: () => deps.metrics?.axeResolution.labels(l).inc(),
      }),
    },
  });

  // Resolve this checkpoint's auto-rule selectors against its DOM +
  // element-map sidecar, producing an engine-shaped map keyed by the rule
  // selector string. Done here (not in the engine) because matching needs a
  // real DOM — esp. attribute selectors the cssPath keys can't express.
  const ruleElementMap: RulesElementMap =
    ctx.ruleSelectors.length > 0
      ? resolveRuleSelectorElementMap(
          ctx.ruleSelectors,
          candidateDom,
          elementMap,
          {
            rulesSelectorResolution: {
              labels: (l) => ({
                inc: () =>
                  deps.metrics?.rulesSelectorResolution.labels(l).inc(),
              }),
            },
          },
        )
      : [];

  let strictFailed = false;
  // Strict tolerance post-filter. Decode the diff image once
  // per viewport (sharp is cheap on PNG → raw RGBA). Any region
  // breaching its tolerance becomes a synthetic "breaking" region
  // AND forces `passed: false`.
  const strictInputs: StrictRegionInput[] = await Promise.all(
    allRegions
      .filter((r) => r.kind === "strict")
      .filter((r) => !r.viewport || r.viewport === (cs.viewport ?? r.viewport))
      .map(async (r) => ({
        resolved: await resolveRegionBbox(
          r,
          elementMapKey,
          bounds,
          ctx.elementMapCache,
          {
            storage: deps.storage,
            logger,
            onOutcome: (outcome) =>
              deps.metrics?.regionResolution.labels({ outcome }).inc(),
          },
        ),
        ...(r.thresholdOverride !== undefined
          ? { thresholdOverride: r.thresholdOverride }
          : {}),
      })),
  );
  if (strictInputs.length > 0 && result.diffImageBytes.length > 0) {
    try {
      const raw = await sharp(result.diffImageBytes).raw().toBuffer({
        resolveWithObject: true,
      });
      const breaches = strictBreaches(strictInputs, {
        data: raw.data,
        info: { width: raw.info.width, height: raw.info.height },
      });
      for (const b of breaches) {
        result.regions.push({
          id: `strict-${b.bbox.x}-${b.bbox.y}-${b.bbox.width}-${b.bbox.height}`,
          severity: "breaking",
          category: "layout",
          bbox: b.bbox,
          description: `Strict region exceeded tolerance: ${(b.fraction * 100).toFixed(3)}% > ${(b.threshold * 100).toFixed(3)}%`,
          source: "l1", // synthesised from the L1 diff image
        });
      }
      if (breaches.length > 0) {
        result.passed = false;
        strictFailed = true;
      }
    } catch (err) {
      logger.warn({ err, runId: run.id }, "strict_tolerance_decode_failed");
    }
  }

  // --- Layout match level (ADR-053): deterministic content/color suppression ---
  // Detect is deterministic; Explain is probabilistic — no model touches this
  // gate. For each L1 pixel cluster: a cluster inside a geometrically-unchanged
  // element is content/color-only → suppress (pass); a cluster over a
  // moved/resized/added element, or inside no element, is kept (fail).
  // Fail-closed: a missing element map degrades the checkpoint to Strict.
  // Only the pixel engines emit l1_pixel clusters; VLM has its own judgment.
  if (screenshotMatchLevel === "Layout" && project.imageComparison !== "vlm") {
    const clusters = result.regions.filter((r) => r.source === "l1_pixel");
    if (clusters.length > 0 && (!elementMap || !baselineElementMap)) {
      // Degrade to Strict: leave result.passed as the engine computed it.
      clusters.forEach(() =>
        deps.metrics?.layoutResolution
          .labels({ outcome: "degraded_no_map" })
          .inc(),
      );
      for (const c of clusters) {
        c.description = `[Layout→Strict: no element map] ${c.description}`;
      }
      logger.warn(
        { runId: run.id, viewport: viewportKey, screenshotId: cs.id },
        "layout_degraded_no_element_map",
      );
    } else if (clusters.length > 0) {
      const verdicts = classifyLayoutClusters(
        clusters.map((c) => c.bbox),
        elementMap,
        baselineElementMap,
      );
      const nonClusters = result.regions.filter((r) => r.source !== "l1_pixel");
      const retagged: typeof result.regions = [];
      let keptCount = 0;
      clusters.forEach((c, i) => {
        const v = verdicts[i]!;
        deps.metrics?.layoutResolution.labels({ outcome: v.reason }).inc();
        const where = v.selector ? ` [${v.selector}]` : "";
        if (v.decision === "suppress") {
          retagged.push({
            ...c,
            source: "layout_suppressed",
            category: "layout",
            severity: "none",
            description: `Layout: stable element — suppressed (content/color only)${where}`,
          });
        } else {
          keptCount++;
          retagged.push({
            ...c,
            source: "layout_kept",
            category: "layout",
            description: `Layout: ${v.reason}${where}`,
          });
        }
      });
      result.regions = [...nonClusters, ...retagged];
      // Layout passes iff no cluster is kept AND strict didn't fail. The
      // global diffPercent gate is intentionally replaced — a recolored hero
      // is a large pixel diff but a stable bbox, so it passes.
      const layoutPasses = keptCount === 0 && !strictFailed;
      // Fail-closed at the L1 cluster cap (keep in sync with
      // l1-region-extractor maxRegions = 12): if it would pass but the cap
      // was hit with pixels still mismatching, unseen clusters might be
      // structural, so we cannot prove a pass.
      if (
        layoutPasses &&
        clusters.length >= 12 &&
        result.pixelMismatchCount > 0
      ) {
        deps.metrics?.layoutResolution
          .labels({ outcome: "cluster_cap_uncertain" })
          .inc();
        result.passed = false;
      } else {
        result.passed = layoutPasses;
      }
    }
  }
  // --- End region modes v2 pipeline ---

  // Observe L1 latency labelled by engine. Image-first (ADR-047): L1
  // always runs, so we always record. Convert ms to seconds to match the
  // histogram's seconds-based bucket boundaries and the OpenMetrics
  // convention.
  deps.metrics?.l1Duration
    .labels({ engine: project.imageComparison })
    .observe(result.durationMs.l1 / 1000);

  let diffImageKey: string | null = null;
  if (result.diffImageBytes.length > 0) {
    diffImageKey = objectKey(result.diffImageBytes);
    await deps.storage.put(diffImageKey, result.diffImageBytes, "image/png");
  }

  const regions: InflatedRegion[] = result.regions.map((r) => ({
    severity: r.severity,
    category: r.category,
    bbox: r.bbox,
    description: r.description,
    source: r.source,
    viewport: viewportKey,
    // v1.1.20: tag each region with the candidate screenshot that
    // produced it so the dashboard can show only the current
    // checkpoint's regions. Before this, two checkpoints sharing a
    // viewport in one run (HomePage + searchResult both at
    // 1280x720) saw each other's regions overlaid in the diff
    // viewer.
    screenshotId: cs.id,
  }));
  const engineIds = regions.map((_r, i) => regionEngineId(0, i));

  // Outcome after auto-rules (see rules-aggregation.ts for the exact rules
  // and its unit tests): `unresolved` if the step still fails after rules,
  // else `passed`. The diff-worker never writes `failed` (reviewer-rejected
  // only).
  const rules = evaluateStepRules(
    ctx,
    cs,
    regions,
    engineIds,
    result.diffPercent,
    ruleElementMap,
  );
  const [failed] = checkpointFailures(
    [{ passed: result.passed, regionCount: regions.length }],
    rules,
  );

  return {
    screenshotId: cs.id,
    verdict: failed ? "unresolved" : "passed",
    firstBaseline: false,
    regions,
    engineIds,
    ranTiers: result.ranTiers,
    diffSignature: computeCheckpointSignature(result.regions, bounds),
    diffImageKey,
    diffPercent: result.diffPercent,
    pixelMismatchCount: result.pixelMismatchCount,
    baselineSource: pairing.source,
    vlmDescription: vlmDescription ?? null,
    ruleResolved: (rules?.counts.auto_approve ?? 0) > 0,
    autoApprove: null,
    ocrAudit,
    ruleDecisions: rules?.decisions ?? [],
    ruleDiagnostics: rules?.diagnostics ?? null,
  };
}

function dedupeRegions(rs: ParsedIgnoreArea[]): ParsedIgnoreArea[] {
  const seen = new Set<string>();
  const out: ParsedIgnoreArea[] = [];
  for (const r of rs) {
    const key = `${r.x}:${r.y}:${r.width}:${r.height}:${r.viewport ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/**
 * Per-region padding (spec §3.3) is applied by the worker — the diff-engine
 * remains padding-agnostic. Inflates the bbox by `paddingPx` on all sides
 * and clamps at the screenshot bounds so the engine never sees negative
 * coordinates or out-of-image widths.
 */
export function inflateRegion(
  r: {
    x: number;
    y: number;
    width: number;
    height: number;
    paddingPx?: number;
  },
  bounds: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const p = r.paddingPx ?? 0;
  if (p === 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
  const x = Math.max(0, r.x - p);
  const y = Math.max(0, r.y - p);
  const right = Math.min(bounds.width, r.x + r.width + p);
  const bottom = Math.min(bounds.height, r.y + r.height + p);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}
