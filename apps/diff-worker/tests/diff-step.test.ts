import {
  asc,
  baselines,
  computePrimarySignature,
  createDb,
  diffRegions,
  eq,
  projects,
  screenshots,
  testRuns,
  users,
  type DB,
} from "@furan/db";
import {
  EXCLUDED_SOURCES,
  severityRank,
  type Severity,
} from "@furan/diff-engine";
import { createStorage, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { Registry } from "prom-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDiffMetrics } from "../src/diff-metrics.js";
import { diffStep, type StepResult } from "../src/diff-step.js";
import { handleDiffJob, loadStepContext } from "../src/handler.js";

import { counterValue } from "./helpers/metrics.js";
import { diffRunPerStep } from "./helpers/step-jobs.js";
import {
  createStepSeeder,
  square,
  SQ,
  type Bbox,
  type ScenarioSpec,
  type Seeded,
} from "./helpers/step-seed.js";

// Dynamic-text OCR is mocked so a run is reproducible: every crop reads as a
// date, so a date-pattern region matches and any other pattern does not.
vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { text: "Mar 5, 2026" } })),
    terminate: vi.fn(),
  })),
}));

/**
 * `diffStep` is the old whole-run loop body run for ONE step (spec
 * 2026-10-23 §4.2), and a run diffed one step job at a time ends where the
 * whole-run handler did. Parity, for every step of the existing worker
 * fixtures (multi-checkpoint, auto-approve, ignore areas, layout, rules):
 * - `diffStep` returns what the whole-run handler stored for that step, and
 *   the old in-memory run fold over those results gives its run totals;
 * - the per-step jobs (`handleDiffJob` with step payloads, committed one by
 *   one in reverse capture order) store the same per step, and their run
 *   totals (`recomputeRunTotals`) are the same.
 *
 * GOLDEN holds the values the whole-run handler stored BEFORE its loop body
 * was moved into `diffStep` (the run's `diffName`, `baselineSource`,
 * `vlmDescription` and `primarySignature`, and each step's own numbers, were
 * captured from the whole-run handler at 6c3778d2, whose fold is the old one),
 * so this test cannot pass just because both sides now run the same code.
 */

const skip =
  !process.env.DATABASE_URL ||
  !process.env.REDIS_URL ||
  !process.env.S3_ENDPOINT;
const desc = skip ? describe.skip : describe;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof handleDiffJob>[1];

// handler.layout.test.ts: div.box A holds the square at 96 (96..240); div.box
// B holds it at 240 (240..384), a moved element.
const BOX_A: Bbox = { x: 80, y: 80, width: 180, height: 180 };
const BOX_B: Bbox = { x: 224, y: 224, width: 176, height: 176 };
// The square at 0 (0..144), wrapped in #box.
const BOX_0: Bbox = { x: 0, y: 0, width: 144, height: 144 };

const BOX_DOM =
  '<!doctype html><html lang="en"><head><title>t</title></head><body><div id="box">box</div></body></html>';
// An image with no alt text: an axe `image-alt` violation.
const A11Y_DOM =
  '<!doctype html><html lang="en"><head><title>t</title></head><body><img src="a.png"></body></html>';

const DATE_PATTERN = String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[\s\-\/]+\d{1,2},?\s+\d{2,4}\b`;
const ORDER_PATTERN = String.raw`^ORDER-\d+$`;

/** What one step's diff produced, in the shape both sides are compared in. */
interface StepOutcome {
  verdict: string | null;
  /** The step's diff regions, sorted (dynamic-text audit rows excluded). */
  regions: Array<{
    severity: string;
    category: string;
    source: string;
    bbox: unknown;
    description: string;
  }>;
  diffSignature: string | null;
  diffImageKey: string | null;
  /** The step was auto-approved: it became its variation's baseline. */
  autoApproved: boolean;
  /** The dynamic-text OCR audit rows, sorted. */
  ocrAudit: Array<{
    bbox: unknown;
    description: string;
    ocrText: string | null;
    ocrMatched: boolean | null;
  }>;
  /** Regions a rule won (its `diff_regions.resolved_by_application_id`). */
  ruleWonRegions: number;
  /** The step's own numbers: NULL when it was not compared, 0 when it was
   * auto-approved without a diff. */
  baselineSource: string | null;
  diffPercent: number | null;
  pixelMismatchCount: number | null;
}

/** The run totals (spec §5). */
interface RunOutcome {
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  diffName: string | null;
  baselineSource: string | null;
  vlmDescription: string | null;
  resolutionSource: string | null;
  primarySignature: string | null;
}

interface Outcome {
  steps: Record<string, StepOutcome>;
  run: RunOutcome;
}

/** A bbox with its keys in one order, so both sides serialize alike. */
const box = (b: unknown): Bbox => {
  const { x, y, width, height } = b as Bbox;
  return { x, y, width, height };
};

/** Rows in a stable order (`diff_regions` has no insertion order to read back). */
const byKey = <T>(rows: T[]): T[] =>
  rows
    .map((row) => ({ row, key: JSON.stringify(row) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ row }) => row);

/** The parity fixtures, one project each, steps in capture order. */
const SCENARIOS: Record<string, () => Promise<ScenarioSpec>> = {
  // handler.multi-checkpoint.test.ts: changed, unchanged, moved, first
  // capture, missing pair, masked by the variation's own region.
  checkpoints: async () => ({
    steps: [
      {
        name: "home",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
      },
      {
        name: "cart",
        baseline: await square("blue", 0),
        candidate: await square("blue", 0),
      },
      {
        name: "moved",
        baseline: await square("red", 0),
        candidate: await square("red", 144),
      },
      { name: "search", baseline: null, candidate: await square("red", 0) },
      {
        name: "drift",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
        pairMissing: true,
      },
      {
        name: "masked",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
        ignoreRegions: [{ x: 0, y: 0, width: 200, height: 200 }],
      },
    ],
  }),
  // handler.auto-approve.test.ts: hash match, past-baseline match, first
  // capture auto-seeded, a real change, and identical pixels under a new key.
  "auto-approve": async () => ({
    autoApproveFeature: true,
    steps: [
      {
        name: "hash",
        baseline: await square("blue", 0),
        candidate: await square("blue", 0),
        sameKey: true,
      },
      {
        name: "past",
        baseline: await square("red", 0),
        candidate: await square("red", 144),
        pastBaseline: await square("red", 144),
      },
      { name: "first", baseline: null, candidate: await square("blue", 0) },
      {
        name: "changed",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
      },
      {
        name: "same",
        baseline: await square("red", 144),
        candidate: await square("red", 144),
      },
    ],
  }),
  // handler.ignore-areas.test.ts: the run's temp regions, a selector-resolved
  // region, padding, a strict region, dynamic text, and an axe pass.
  regions: async () => ({
    dynamicTextEnabled: true,
    tempIgnoreAreas: [{ x: 240, y: 240, width: 144, height: 144 }],
    steps: [
      {
        name: "temp",
        baseline: await square("red", 240),
        candidate: await square("blue", 240),
      },
      {
        name: "selector",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
        candidateMap: { "#box": BOX_0 },
        ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1, selector: "#box" }],
      },
      {
        name: "padded",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
        ignoreRegions: [{ x: 8, y: 8, width: 128, height: 128, paddingPx: 8 }],
      },
      {
        name: "strict",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
        ignoreRegions: [
          { x: 0, y: 0, width: 144, height: 144, kind: "strict" },
        ],
      },
      {
        name: "ocr",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
        ignoreRegions: [
          {
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            kind: "dynamic-text",
            pattern: DATE_PATTERN,
          },
          {
            x: 200,
            y: 200,
            width: 40,
            height: 40,
            kind: "dynamic-text",
            pattern: ORDER_PATTERN,
          },
        ],
      },
      {
        name: "a11y",
        baseline: await square("blue", 0),
        candidate: await square("blue", 0),
        candidateDom: A11Y_DOM,
        candidateMap: {
          "html > body > img": { x: 10, y: 10, width: 20, height: 20 },
        },
        accessibilityLevel: "AA",
      },
    ],
  }),
  // handler.layout.test.ts: suppressed, kept, degraded (no map), and Strict.
  layout: async () => ({
    steps: [
      {
        name: "suppressed",
        baseline: await square("red", 96),
        candidate: await square("blue", 96),
        matchLevel: "Layout",
        baselineMap: { "div.box": BOX_A },
        candidateMap: { "div.box": BOX_A },
      },
      {
        name: "kept",
        baseline: await square("red", 96),
        candidate: await square("red", 240),
        matchLevel: "Layout",
        baselineMap: { "div.box": BOX_A },
        candidateMap: { "div.box": BOX_B },
      },
      {
        name: "degraded",
        baseline: await square("red", 96),
        candidate: await square("blue", 96),
        matchLevel: "Layout",
      },
      {
        name: "strictLevel",
        baseline: await square("red", 96),
        candidate: await square("blue", 96),
        matchLevel: "Strict",
        baselineMap: { "div.box": BOX_A },
        candidateMap: { "div.box": BOX_A },
      },
    ],
  }),
  // Auto rules: a selector rule auto-approves the second step's change; its
  // decision, keyed `0:i` by the step, must reach that step's stored region.
  rules: async () => ({
    ruleSelectors: ["#box"],
    steps: [
      {
        name: "same",
        baseline: await square("blue", 0),
        candidate: await square("blue", 0),
      },
      {
        name: "ruled",
        baseline: await square("red", 0),
        candidate: await square("blue", 0),
        candidateDom: BOX_DOM,
        candidateMap: { "#box": BOX_0 },
      },
    ],
  }),
};

// ── Golden values ──────────────────────────────────────────────────────────
// Captured from the whole-run handler before its loop body moved into
// `diffStep`. Every value is deterministic: diff image keys are content
// hashes of the diff PNG, signatures hash the regions.
const CLUSTER = "Pixel diff cluster (9 tiles, 144×144)";
const l1Cluster = (pos: number, description = CLUSTER) => ({
  severity: "minor",
  category: "image",
  source: "l1_pixel",
  bbox: { x: pos, y: pos, width: SQ, height: SQ },
  description,
});
// The red→blue recolour of the square at 0 and at 96: diff image, signature.
const DIFF_RECOLOR_0 =
  "0a1b2ebad1c92266b1ad454f36c738d6ffc5287e108057f3a9c749c79739e50b";
const SIG_RECOLOR_0 =
  "v1:ce99865c4693f33bf0ec4c2ef4e8cba2d20f9e8cbca17dd2002377f965d34838";
const DIFF_RECOLOR_96 =
  "80df4d02a5cdf0232187cc468e07c98c482978c2fc8cbfd594c7fb88e78e283a";
const SIG_RECOLOR_96 =
  "v1:17875aee0d990933d8caaf10e0179018a81a50e4a2442cb4c4f5fa31e803a9d2";
// The square moved from 0 to 144: diff image.
const DIFF_MOVED_0_144 =
  "dea792f6f0b03904c2ec0c7abdfbbf04a6ab112875b1f22da3eff1e3e90b86a8";
// The strict step's signature (its breach region plus the recolour cluster).
const SIG_STRICT_0 =
  "v1:fb0f1951837b4b8b4a28741bf60d85ce84702c29eaee33f423f8f88db5a15313";
// The square moved from 96 to 240 under Layout: diff image.
const DIFF_KEPT_96_240 =
  "e070367ab7de5022db159fe03b778190d93ba22a4b0c879c61cae14af4c30f71";

// A step's own numbers: the recolour of one 144px square (20521 px of 400²),
// a move (the square leaves one place and appears in another), and a step
// compared at 0% (identical, masked, or auto-approved without a diff).
const RECOLOR_NUMBERS = {
  baselineSource: "this_branch",
  diffPercent: 12.825625,
  pixelMismatchCount: 20521,
};
const MOVED_NUMBERS = {
  baselineSource: "this_branch",
  diffPercent: 25.785625,
  pixelMismatchCount: 41257,
};
const ZERO = {
  baselineSource: "this_branch",
  diffPercent: 0,
  pixelMismatchCount: 0,
};
/** A first capture: no baseline resolved, nothing compared. */
const NOT_COMPARED = {
  baselineSource: null,
  diffPercent: null,
  pixelMismatchCount: null,
};

/** A step the diff left no output on: not diffed, masked, or identical. */
const NO_OUTPUT = {
  regions: [],
  diffSignature: null,
  diffImageKey: null,
  autoApproved: false,
  ocrAudit: [],
  ruleWonRegions: 0,
};
const RECOLOR_0 = {
  ...NO_OUTPUT,
  ...RECOLOR_NUMBERS,
  verdict: "unresolved",
  regions: [l1Cluster(0)],
  diffSignature: SIG_RECOLOR_0,
  diffImageKey: DIFF_RECOLOR_0,
};

const GOLDEN: Record<string, Outcome> = {
  checkpoints: {
    steps: {
      home: RECOLOR_0,
      cart: { ...NO_OUTPUT, ...ZERO, verdict: "passed" },
      moved: {
        ...NO_OUTPUT,
        ...MOVED_NUMBERS,
        verdict: "unresolved",
        regions: [l1Cluster(0), l1Cluster(144)],
        diffSignature:
          "v1:699e370af62b3cf010c89e58448c15f7212463e70bc785c99e048110f5d22265",
        diffImageKey: DIFF_MOVED_0_144,
      },
      search: { ...NO_OUTPUT, ...NOT_COMPARED, verdict: "new" },
      // A missing pair: its baseline resolved (a source), but nothing compared.
      drift: {
        ...NO_OUTPUT,
        ...NOT_COMPARED,
        baselineSource: "this_branch",
        verdict: "new",
      },
      masked: { ...NO_OUTPUT, ...ZERO, verdict: "passed" },
    },
    run: {
      diffPercent: 25.785625,
      pixelMisMatchCount: 61778,
      diffName: DIFF_MOVED_0_144,
      baselineSource: "this_branch",
      vlmDescription: null,
      resolutionSource: null,
      primarySignature: SIG_RECOLOR_0,
    },
  },
  "auto-approve": {
    steps: {
      hash: { ...NO_OUTPUT, ...ZERO, verdict: "passed", autoApproved: true },
      past: { ...NO_OUTPUT, ...ZERO, verdict: "passed", autoApproved: true },
      first: {
        ...NO_OUTPUT,
        ...NOT_COMPARED,
        verdict: "new",
        autoApproved: true,
      },
      changed: RECOLOR_0,
      same: { ...NO_OUTPUT, ...ZERO, verdict: "passed" },
    },
    run: {
      diffPercent: 12.825625,
      pixelMisMatchCount: 20521,
      diffName: DIFF_RECOLOR_0,
      baselineSource: "this_branch",
      vlmDescription: null,
      resolutionSource: null,
      primarySignature: SIG_RECOLOR_0,
    },
  },
  regions: {
    steps: {
      temp: { ...NO_OUTPUT, ...ZERO, verdict: "passed" },
      selector: { ...NO_OUTPUT, ...ZERO, verdict: "passed" },
      padded: { ...NO_OUTPUT, ...ZERO, verdict: "passed" },
      strict: {
        ...RECOLOR_0,
        regions: [
          {
            severity: "breaking",
            category: "layout",
            source: "l1",
            bbox: { x: 0, y: 0, width: 144, height: 144 },
            description: "Strict region exceeded tolerance: 100.000% > 0.000%",
          },
          l1Cluster(0),
        ],
        diffSignature: SIG_STRICT_0,
      },
      ocr: {
        ...RECOLOR_0,
        // The matched date region (0,0 40×40) masks part of the recolour.
        diffPercent: 9.2125,
        pixelMismatchCount: 14740,
        diffImageKey:
          "8e7689fdc35c431648faf3340ef2b0f3980c7490722dfe7be765cc7a68b8cd72",
        ocrAudit: [
          {
            bbox: { x: 0, y: 0, width: 40, height: 40 },
            description: 'Dynamic text matched: "Mar 5, 2026"',
            ocrText: "Mar 5, 2026",
            ocrMatched: true,
          },
          {
            bbox: { x: 200, y: 200, width: 40, height: 40 },
            description: 'Dynamic text did NOT match: "Mar 5, 2026"',
            ocrText: "Mar 5, 2026",
            ocrMatched: false,
          },
        ],
      },
      a11y: {
        ...NO_OUTPUT,
        ...ZERO,
        verdict: "passed",
        regions: [
          {
            severity: "breaking",
            category: "accessibility",
            source: "axe",
            bbox: { x: 10, y: 10, width: 20, height: 20 },
            description: "image-alt: Images must have alternative text",
          },
        ],
        diffSignature:
          "v1:967aeea52975c97d58c69785f3fbbeca72ea2e056a970050d788ab9f5959284e",
      },
    },
    run: {
      diffPercent: 12.825625,
      pixelMisMatchCount: 35261,
      diffName: DIFF_RECOLOR_0,
      baselineSource: "this_branch",
      vlmDescription: null,
      resolutionSource: null,
      primarySignature: SIG_STRICT_0,
    },
  },
  layout: {
    steps: {
      suppressed: {
        ...NO_OUTPUT,
        ...RECOLOR_NUMBERS,
        verdict: "passed",
        regions: [
          {
            severity: "none",
            category: "layout",
            source: "layout_suppressed",
            bbox: { x: 96, y: 96, width: 144, height: 144 },
            description:
              "Layout: stable element — suppressed (content/color only) [div.box]",
          },
        ],
        diffImageKey: DIFF_RECOLOR_96,
      },
      kept: {
        ...NO_OUTPUT,
        ...MOVED_NUMBERS,
        verdict: "unresolved",
        regions: [
          {
            severity: "minor",
            category: "layout",
            source: "layout_kept",
            bbox: { x: 240, y: 240, width: 144, height: 144 },
            description: "Layout: moved_or_resized [div.box]",
          },
          {
            severity: "minor",
            category: "layout",
            source: "layout_kept",
            bbox: { x: 96, y: 96, width: 144, height: 144 },
            description: "Layout: orphan_no_container",
          },
        ],
        diffSignature:
          "v1:2f564fd9d8069bd84a8434cbd5f3d7c952167886a2fdc73514d9d6478d62cf92",
        diffImageKey: DIFF_KEPT_96_240,
      },
      degraded: {
        ...NO_OUTPUT,
        ...RECOLOR_NUMBERS,
        verdict: "unresolved",
        regions: [l1Cluster(96, `[Layout→Strict: no element map] ${CLUSTER}`)],
        diffSignature: SIG_RECOLOR_96,
        diffImageKey: DIFF_RECOLOR_96,
      },
      strictLevel: {
        ...NO_OUTPUT,
        ...RECOLOR_NUMBERS,
        verdict: "unresolved",
        regions: [l1Cluster(96)],
        diffSignature: SIG_RECOLOR_96,
        diffImageKey: DIFF_RECOLOR_96,
      },
    },
    run: {
      diffPercent: 25.785625,
      pixelMisMatchCount: 102820,
      diffName: DIFF_KEPT_96_240,
      baselineSource: "this_branch",
      vlmDescription: null,
      resolutionSource: null,
      primarySignature: SIG_RECOLOR_96,
    },
  },
  rules: {
    steps: {
      same: { ...NO_OUTPUT, ...ZERO, verdict: "passed" },
      ruled: { ...RECOLOR_0, verdict: "passed", ruleWonRegions: 1 },
    },
    run: {
      diffPercent: 12.825625,
      pixelMisMatchCount: 20521,
      diffName: DIFF_RECOLOR_0,
      baselineSource: "this_branch",
      vlmDescription: null,
      resolutionSource: "rule",
      primarySignature: SIG_RECOLOR_0,
    },
  },
};

/**
 * The diff-worker's old in-memory run fold (the whole-run handler at
 * aca5016d, with `?? 0` for the numbers a step not compared now leaves NULL),
 * over the steps' results in capture order.
 */
function oldRunFold(results: StepResult[]): RunOutcome {
  const compared = results.some((r) => !r.firstBaseline);
  const pct = (r: StepResult) => r.diffPercent ?? 0;
  const worstOf = (rs: StepResult[]) =>
    rs.reduce<StepResult | null>(
      (acc, v) => (acc === null || pct(v) > pct(acc) ? v : acc),
      null,
    );
  return {
    diffPercent: compared
      ? results.reduce((m, v) => (pct(v) > m ? pct(v) : m), 0)
      : null,
    pixelMisMatchCount: compared
      ? results.reduce((n, v) => n + (v.pixelMismatchCount ?? 0), 0)
      : null,
    diffName: worstOf(results)?.diffImageKey ?? null,
    baselineSource:
      worstOf(results.filter((r) => r.baselineSource !== null))
        ?.baselineSource ?? null,
    vlmDescription:
      results.find((v) => v.vlmDescription)?.vlmDescription ?? null,
    // The old `aggregateRuleStatus`: no step still fails and a rule
    // auto-approved one.
    resolutionSource:
      !results.some((r) => r.verdict === "unresolved") &&
      results.some((r) => r.ruleResolved)
        ? "rule"
        : null,
    primarySignature: computePrimarySignature(
      results.map((v) => ({
        diffSignature: v.diffSignature,
        worstSeverity: v.regions
          .filter((r) => !EXCLUDED_SOURCES.has(r.source))
          .reduce<Severity>(
            (worst, r) =>
              severityRank(r.severity as Severity) > severityRank(worst)
                ? (r.severity as Severity)
                : worst,
            "none",
          ),
      })),
    ),
  };
}

desc("diffStep (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];
  let seed: (spec: ScenarioSpec) => Promise<Seeded>;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);

    const [u] = await db
      .insert(users)
      .values({
        email: `dw-step-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "diff-step",
        role: "admin",
      })
      .returning();
    userId = u!.id;
    seed = createStepSeeder({ db, storage, userId, projectIds });
  }, 60_000);

  afterAll(async () => {
    for (const id of projectIds) {
      try {
        await db.delete(projects).where(eq(projects.id, id));
      } catch {
        /* best-effort cleanup */
      }
    }
    await redis.quit();
    await closeDb();
  });

  /** What the per-step jobs stored, per step and on the run. */
  async function storedOutcome(s: Seeded): Promise<Outcome> {
    const steps: Record<string, StepOutcome> = {};
    for (const [name, id] of Object.entries(s.shotId)) {
      const [shot] = await db
        .select()
        .from(screenshots)
        .where(eq(screenshots.id, id));
      const rows = await db
        .select()
        .from(diffRegions)
        .where(eq(diffRegions.screenshotId, id));
      const ownBaseline = await db
        .select({ variation: baselines.testVariationId })
        .from(baselines)
        .where(eq(baselines.testRunId, s.candidateRunId));
      const regions = rows.filter((r) => r.source !== "dynamic_text");
      steps[name] = {
        verdict: shot!.verdict,
        regions: byKey(
          regions.map((r) => ({
            severity: r.severity,
            category: r.category,
            source: r.source,
            bbox: box(r.bbox),
            description: r.description,
          })),
        ),
        diffSignature: shot!.diffSignature,
        diffImageKey: shot!.diffImageKey,
        autoApproved: ownBaseline.some(
          (bl) => bl.variation === s.variationId[name],
        ),
        ocrAudit: byKey(
          rows
            .filter((r) => r.source === "dynamic_text")
            .map((r) => ({
              bbox: box(r.bbox),
              description: r.description,
              ocrText: r.ocrText,
              ocrMatched: r.ocrMatched,
            })),
        ),
        ruleWonRegions: regions.filter(
          (r) => r.resolvedByApplicationId !== null,
        ).length,
        baselineSource: shot!.baselineSource,
        diffPercent: shot!.diffPercent,
        pixelMismatchCount: shot!.pixelMismatchCount,
      };
    }
    const [run] = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.candidateRunId));
    return {
      steps,
      run: {
        diffPercent: run!.diffPercent,
        pixelMisMatchCount: run!.pixelMisMatchCount,
        diffName: run!.diffName,
        baselineSource: run!.baselineSource,
        vlmDescription: run!.vlmDescription,
        resolutionSource: run!.resolutionSource,
        primarySignature: run!.primarySignature,
      },
    };
  }

  /** The context `handleDiffJob` builds for one run's steps. */
  async function contextFor(s: Seeded, metrics?: Registry) {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, s.projectId),
    });
    const run = await db.query.testRuns.findFirst({
      where: eq(testRuns.id, s.candidateRunId),
    });
    const shots = await db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, s.candidateRunId))
      .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
    const ctx = await loadStepContext(
      {
        db,
        storage,
        redis,
        ...(metrics ? { metrics: createDiffMetrics(metrics) } : {}),
      },
      mockLogger,
      {
        project: project!,
        run: run!,
        variationIds: shots.map((cs) => cs.testVariationId),
      },
    );
    return { ctx, shots };
  }

  /**
   * What `diffStep` returns for each step of the run, in the shape of
   * `storedOutcome`, and the old in-memory fold of those results.
   */
  async function steppedOutcome(s: Seeded): Promise<Outcome> {
    const { ctx, shots } = await contextFor(s);
    const results: StepResult[] = [];
    for (const cs of shots) results.push(await diffStep(ctx, cs));

    const nameOf = new Map(
      Object.entries(s.shotId).map(([name, id]) => [id, name]),
    );
    const steps: Record<string, StepOutcome> = {};
    for (const r of results) {
      const won = new Set(
        r.ruleDecisions
          .filter((d) => d.winningRule !== null)
          .map((d) => d.regionId),
      );
      steps[nameOf.get(r.screenshotId)!] = {
        verdict: r.verdict,
        regions: byKey(
          r.regions.map((region) => ({
            severity: region.severity,
            category: region.category,
            source: region.source,
            bbox: box(region.bbox),
            description: region.description,
          })),
        ),
        diffSignature: r.diffSignature,
        diffImageKey: r.diffImageKey,
        autoApproved: r.autoApprove !== null,
        ocrAudit: byKey(
          r.ocrAudit.map((row) => ({
            bbox: box(row.bbox),
            description: row.description,
            ocrText: row.ocrText,
            ocrMatched: row.ocrMatched,
          })),
        ),
        ruleWonRegions: r.engineIds.filter((id) => won.has(id)).length,
        baselineSource: r.baselineSource,
        diffPercent: r.diffPercent,
        pixelMismatchCount: r.pixelMismatchCount,
      };
    }
    return { steps, run: oldRunFold(results) };
  }

  it.each(Object.keys(SCENARIOS))(
    "per step and in the run totals, diffStep and the per-step jobs reproduce the whole-run handler: %s",
    async (name) => {
      const spec = await SCENARIOS[name]!();

      // The per-step jobs, committed one by one in REVERSE capture order: the
      // totals are rebuilt from the stored steps, whatever order they land in.
      const perStep = await seed(spec);
      const outcomes = await diffRunPerStep(
        { runId: perStep.candidateRunId, projectId: perStep.projectId },
        mockLogger,
        { db, storage, redis },
        { reverse: true },
      );
      expect(outcomes).toEqual(spec.steps.map(() => ({ checkpoints: 1 })));
      const stored = await storedOutcome(perStep);

      // A fresh copy of the same seed, so the jobs' writes (auto-approved
      // baselines, say) do not change what the steps resolve.
      const fresh = await seed(spec);
      const stepped = await steppedOutcome(fresh);

      expect(stepped).toEqual(stored);
      expect(stored).toEqual(GOLDEN[name]);
      expect(stepped).toEqual(GOLDEN[name]);

      // `diffStep` stores no result: no verdict, region or baseline.
      const freshShots = await db
        .select({ verdict: screenshots.verdict })
        .from(screenshots)
        .where(eq(screenshots.runId, fresh.candidateRunId));
      expect(freshShots.every((shot) => shot.verdict === null)).toBe(true);
      expect(
        await db
          .select({ id: diffRegions.id })
          .from(diffRegions)
          .where(eq(diffRegions.runId, fresh.candidateRunId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: baselines.id })
          .from(baselines)
          .where(eq(baselines.testRunId, fresh.candidateRunId)),
      ).toEqual([]);
    },
    120_000,
  );

  it("a step whose rule evaluation throws loses only its own rule decisions", async () => {
    // Both steps' changes sit inside `#box`, so the auto_approve rule resolves
    // each of them; the first step's change is at (0, 0), the second's at 240.
    const BOX_240: Bbox = { x: 240, y: 240, width: SQ, height: SQ };
    const s = await seed({
      ruleSelectors: ["#box"],
      steps: [
        {
          name: "boom",
          baseline: await square("red", 0),
          candidate: await square("blue", 0),
          candidateDom: BOX_DOM,
          candidateMap: { "#box": BOX_0 },
        },
        {
          name: "ruled",
          baseline: await square("red", 240),
          candidate: await square("blue", 240),
          candidateDom: BOX_DOM,
          candidateMap: { "#box": BOX_240 },
        },
      ],
    });
    const registry = new Registry();
    const { ctx, shots } = await contextFor(s, registry);
    const [boomShot, ruledShot] = shots;
    const errorCount = () =>
      counterValue(registry, "furan_diff_rules_evaluation_errors_total");

    // With the rules as compiled, the first step is resolved by its rule.
    const resolved = await diffStep(ctx, boomShot!);
    expect(resolved.verdict).toBe("passed");
    expect(resolved.ruleDecisions).toHaveLength(1);

    // The compiled rules, with a matcher that throws on the first step's
    // region (at 0, 0) only.
    const compiled = ctx.compiledRules!;
    ctx.compiledRules = {
      ...compiled,
      rules: compiled.rules.map((rule) => ({
        ...rule,
        matcher: (region, elementMap) => {
          if (region.bbox.x === 0) throw new Error("matcher_boom");
          return rule.matcher(region, elementMap);
        },
      })),
    };
    const errorsBefore = await errorCount();
    vi.mocked(mockLogger.error).mockClear();

    const boom = await diffStep(ctx, boomShot!);
    const ruled = await diffStep(ctx, ruledShot!);

    // That step: no decisions, so its change stays unresolved.
    expect(boom.verdict).toBe("unresolved");
    expect(boom.ruleDecisions).toEqual([]);
    expect(boom.ruleResolved).toBe(false);
    expect(boom.ruleDiagnostics).toBeNull();
    expect((await errorCount()) - errorsBefore).toBe(1);
    expect(vi.mocked(mockLogger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotId: boomShot!.id }),
      "rules-engine evaluation failed; proceeding without rule decisions",
    );
    // Its sibling keeps its own decisions.
    expect(ruled.verdict).toBe("passed");
    expect(ruled.ruleDecisions).toHaveLength(1);
    expect(ruled.ruleDecisions[0]!.finalAction).toBe("auto_approve");
    expect(ruled.ruleResolved).toBe(true);
  }, 60_000);
});
