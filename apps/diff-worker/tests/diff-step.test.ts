import {
  asc,
  autoRules,
  baselines,
  builds,
  createDb,
  diffRegions,
  eq,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import type { DiffJob } from "@furan/queue";
import { createStorage, objectKey, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { diffStep, type StepResult } from "../src/diff-step.js";
import { handleDiffJob, loadStepContext } from "../src/handler.js";

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
 * 2026-10-23 §4.2). Parity: for every step of the existing worker fixtures
 * (multi-checkpoint, auto-approve, ignore areas, layout, rules), `diffStep`
 * returns what the whole-run handler stores for that step.
 *
 * GOLDEN holds the values the whole-run handler stored BEFORE the loop body
 * was moved into `diffStep`, so this test cannot pass just
 * because both sides now run the same code.
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

// The tile-aligned helper of handler.multi-checkpoint.test.ts and
// handler.layout.test.ts: a 400x400 white PNG with a 144px (3x3 tiles of 48px)
// square at (pos, pos), so a change produces real L1 clusters.
const IMG = 400;
const SQ = 144;
const VP = "400x400";
type Bbox = { x: number; y: number; width: number; height: number };

async function square(color: "red" | "blue", pos: number): Promise<Buffer> {
  const fg =
    color === "red"
      ? { r: 220, g: 30, b: 30, alpha: 1 }
      : { r: 30, g: 30, b: 220, alpha: 1 };
  return sharp({
    create: {
      width: IMG,
      height: IMG,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: {
          create: { width: SQ, height: SQ, channels: 4, background: fg },
        },
        left: pos,
        top: pos,
      },
    ])
    .png()
    .toBuffer();
}

const elementMapBytes = (elements: Record<string, Bbox>): Buffer =>
  Buffer.from(JSON.stringify({ v: 1, elements, capturedAt: 0 }));

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

interface StepSpec {
  name: string;
  /** Baseline image; `null` = the step has never been baselined. */
  baseline: Buffer | null;
  candidate: Buffer;
  /** Store the candidate under the baseline's object key (ADR-032 hash match). */
  sameKey?: boolean;
  /** A baselines row whose run holds no screenshot of the variation. */
  pairMissing?: boolean;
  /** An OLDER baseline of the variation holding this image (past-baseline match). */
  pastBaseline?: Buffer;
  /** Ignore regions stored on this step's variation. */
  ignoreRegions?: unknown[];
  matchLevel?: "Strict" | "Layout";
  baselineMap?: Record<string, Bbox>;
  candidateMap?: Record<string, Bbox>;
  candidateDom?: string;
  accessibilityLevel?: "AA";
}

interface ScenarioSpec {
  steps: StepSpec[];
  autoApproveFeature?: boolean;
  dynamicTextEnabled?: boolean;
  /** The candidate run's temp ignore areas (every step of the run). */
  tempIgnoreAreas?: unknown[];
  /** Selectors of enabled `auto_approve` rules. */
  ruleSelectors?: string[];
}

interface Seeded {
  projectId: string;
  candidateRunId: string;
  /** Candidate screenshot id by step name. */
  shotId: Record<string, string>;
  variationId: Record<string, string>;
}

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
}

interface RunOutcome {
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  resolutionSource: string | null;
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
  // Auto rules: a selector rule auto-approves the second step's change, so
  // its decisions are re-keyed from the step's `0:i` to the run's `1:i`.
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
  verdict: "unresolved",
  regions: [l1Cluster(0)],
  diffSignature: SIG_RECOLOR_0,
  diffImageKey: DIFF_RECOLOR_0,
};

const GOLDEN: Record<string, Outcome> = {
  checkpoints: {
    steps: {
      home: RECOLOR_0,
      cart: { ...NO_OUTPUT, verdict: "passed" },
      moved: {
        ...NO_OUTPUT,
        verdict: "unresolved",
        regions: [l1Cluster(0), l1Cluster(144)],
        diffSignature:
          "v1:699e370af62b3cf010c89e58448c15f7212463e70bc785c99e048110f5d22265",
        diffImageKey:
          "dea792f6f0b03904c2ec0c7abdfbbf04a6ab112875b1f22da3eff1e3e90b86a8",
      },
      search: { ...NO_OUTPUT, verdict: "new" },
      drift: { ...NO_OUTPUT, verdict: "new" },
      masked: { ...NO_OUTPUT, verdict: "passed" },
    },
    run: {
      diffPercent: 25.785625,
      pixelMisMatchCount: 61778,
      resolutionSource: null,
    },
  },
  "auto-approve": {
    steps: {
      hash: { ...NO_OUTPUT, verdict: "passed", autoApproved: true },
      past: { ...NO_OUTPUT, verdict: "passed", autoApproved: true },
      first: { ...NO_OUTPUT, verdict: "new", autoApproved: true },
      changed: RECOLOR_0,
      same: { ...NO_OUTPUT, verdict: "passed" },
    },
    run: {
      diffPercent: 12.825625,
      pixelMisMatchCount: 20521,
      resolutionSource: null,
    },
  },
  regions: {
    steps: {
      temp: { ...NO_OUTPUT, verdict: "passed" },
      selector: { ...NO_OUTPUT, verdict: "passed" },
      padded: { ...NO_OUTPUT, verdict: "passed" },
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
        diffSignature:
          "v1:fb0f1951837b4b8b4a28741bf60d85ce84702c29eaee33f423f8f88db5a15313",
      },
      ocr: {
        ...RECOLOR_0,
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
      resolutionSource: null,
    },
  },
  layout: {
    steps: {
      suppressed: {
        ...NO_OUTPUT,
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
        diffImageKey:
          "e070367ab7de5022db159fe03b778190d93ba22a4b0c879c61cae14af4c30f71",
      },
      degraded: {
        ...NO_OUTPUT,
        verdict: "unresolved",
        regions: [l1Cluster(96, `[Layout→Strict: no element map] ${CLUSTER}`)],
        diffSignature: SIG_RECOLOR_96,
        diffImageKey: DIFF_RECOLOR_96,
      },
      strictLevel: {
        ...NO_OUTPUT,
        verdict: "unresolved",
        regions: [l1Cluster(96)],
        diffSignature: SIG_RECOLOR_96,
        diffImageKey: DIFF_RECOLOR_96,
      },
    },
    run: {
      diffPercent: 25.785625,
      pixelMisMatchCount: 102820,
      resolutionSource: null,
    },
  },
  rules: {
    steps: {
      same: { ...NO_OUTPUT, verdict: "passed" },
      ruled: { ...RECOLOR_0, verdict: "passed", ruleWonRegions: 1 },
    },
    run: {
      diffPercent: 12.825625,
      pixelMisMatchCount: 20521,
      resolutionSource: "rule",
    },
  },
};

desc("diffStep (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];

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

  /**
   * One project per call, so two calls with one spec are independent copies.
   * Each step gets its own variation and baseline run (as in
   * handler.multi-checkpoint.test.ts); the candidate run holds one screenshot
   * per step, in spec order.
   */
  async function seed(spec: ScenarioSpec): Promise<Seeded> {
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-step-${uniq}`,
        mainBranchName: "main",
        diffThreshold: 0.001,
        autoApproveFeature: spec.autoApproveFeature ?? false,
        dynamicTextEnabled: spec.dynamicTextEnabled ?? false,
      })
      .returning();
    const projectId = p!.id;
    projectIds.push(projectId);
    const [b] = await db
      .insert(builds)
      .values({ projectId, userId, isRunning: false })
      .returning();
    const buildId = b!.id;

    for (const selector of spec.ruleSelectors ?? []) {
      await db.insert(autoRules).values({
        projectId,
        label: `rule ${selector}`,
        match: { type: "selector", value: selector },
        action: "auto_approve",
        createdBy: userId,
        updatedBy: userId,
      });
    }

    const putMap = async (
      elements: Record<string, Bbox> | undefined,
      suffix: string,
    ): Promise<string | null> => {
      if (!elements) return null;
      const bytes = elementMapBytes(elements);
      const key = `${objectKey(bytes)}-${uniq}-${suffix}`;
      await storage.put(key, bytes, "application/json");
      return key;
    };
    const newRun = async (name: string, status: "passed" | "running") => {
      const [r] = await db
        .insert(testRuns)
        .values({
          name,
          projectId,
          buildId,
          branchName: "main",
          status,
          ...(status === "running" && spec.tempIgnoreAreas
            ? { tempIgnoreAreas: JSON.stringify(spec.tempIgnoreAreas) }
            : {}),
        })
        .returning();
      return r!.id;
    };

    const variationId: Record<string, string> = {};
    const baselineKey: Record<string, string> = {};
    for (const step of spec.steps) {
      const [v] = await db
        .insert(testVariations)
        .values({
          name: step.name,
          projectId,
          branchName: "main",
          browser: "chromium",
          viewport: VP,
          ignoreRegions: step.ignoreRegions ?? null,
        })
        .returning();
      variationId[step.name] = v!.id;

      if (step.pastBaseline) {
        const runId = await newRun(`past-${step.name}`, "passed");
        const key = `${objectKey(step.pastBaseline)}-${uniq}-${step.name}-past`;
        await storage.put(key, step.pastBaseline, "image/png");
        await db.insert(screenshots).values({
          runId,
          projectId,
          testVariationId: v!.id,
          name: step.name,
          imageKey: key,
          viewport: VP,
          browser: "chromium",
        });
        await db.insert(baselines).values({
          baselineName: `${step.name}-past`,
          testVariationId: v!.id,
          testRunId: runId,
          branchName: "main",
          userId,
          createdAt: new Date(Date.now() - 60 * 60_000),
        });
      }

      if (!step.baseline) continue;
      const runId = await newRun(`baseline-${step.name}`, "passed");
      const key = `${objectKey(step.baseline)}-${uniq}-${step.name}-bl`;
      await storage.put(key, step.baseline, "image/png");
      baselineKey[step.name] = key;
      if (!step.pairMissing) {
        await db.insert(screenshots).values({
          runId,
          projectId,
          testVariationId: v!.id,
          name: step.name,
          imageKey: key,
          viewport: VP,
          browser: "chromium",
          matchLevel: step.matchLevel ?? "Strict",
          elementMapKey: await putMap(step.baselineMap, `${step.name}-blmap`),
        });
      }
      await db.insert(baselines).values({
        baselineName: key,
        testVariationId: v!.id,
        testRunId: runId,
        branchName: "main",
        userId,
      });
    }

    const candidateRunId = await newRun("candidate", "running");
    const shotId: Record<string, string> = {};
    // Explicit capture order (the handler reads steps by created_at, id).
    const t0 = Date.now();
    for (const [i, step] of spec.steps.entries()) {
      let imageKey = `${objectKey(step.candidate)}-${uniq}-${step.name}-cd`;
      if (step.sameKey) {
        imageKey = baselineKey[step.name]!;
      } else {
        await storage.put(imageKey, step.candidate, "image/png");
      }
      let domKey: string | null = null;
      if (step.candidateDom) {
        domKey = `${uniq}-${step.name}.html`;
        await storage.put(domKey, Buffer.from(step.candidateDom), "text/html");
      }
      const [cs] = await db
        .insert(screenshots)
        .values({
          runId: candidateRunId,
          projectId,
          testVariationId: variationId[step.name]!,
          name: step.name,
          imageKey,
          domKey,
          viewport: VP,
          browser: "chromium",
          matchLevel: step.matchLevel ?? "Strict",
          elementMapKey: await putMap(step.candidateMap, `${step.name}-cdmap`),
          accessibilityLevel: step.accessibilityLevel ?? null,
          createdAt: new Date(t0 + i * 1000),
        })
        .returning();
      shotId[step.name] = cs!.id;
    }

    return { projectId, candidateRunId, shotId, variationId };
  }

  /** What the whole-run handler stored, per step and on the run. */
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
        resolutionSource: run!.resolutionSource,
      },
    };
  }

  /**
   * What `diffStep` returns for each step of the run, in the shape of
   * `storedOutcome`, and the run's numbers folded from the steps' own (a step
   * with no baseline image has no diff % and is not compared).
   */
  async function steppedOutcome(s: Seeded): Promise<Outcome> {
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
    const ctx = await loadStepContext({ db, storage, redis }, mockLogger, {
      project: project!,
      run: run!,
      variationIds: shots.map((cs) => cs.testVariationId),
    });
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
      };
    }
    const compared = results.filter((r) => r.diffPercent !== null);
    return {
      steps,
      run: {
        diffPercent:
          compared.length > 0
            ? Math.max(...compared.map((r) => r.diffPercent!))
            : null,
        pixelMisMatchCount:
          compared.length > 0
            ? compared.reduce((n, r) => n + r.pixelMismatchCount!, 0)
            : null,
        resolutionSource:
          !results.some((r) => r.verdict === "unresolved") &&
          results.some((r) => r.ruleResolved)
            ? "rule"
            : null,
      },
    };
  }

  it.each(Object.keys(SCENARIOS))(
    "diffStep returns, per step, exactly what the whole-run handler stored: %s",
    async (name) => {
      const spec = await SCENARIOS[name]!();

      const whole = await seed(spec);
      await handleDiffJob(
        { runId: whole.candidateRunId, projectId: whole.projectId } as DiffJob,
        mockLogger,
        { db, storage, redis },
      );
      const stored = await storedOutcome(whole);

      // A fresh copy of the same seed, so the handler's writes (auto-approved
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
});
