import {
  autoRules,
  baselines,
  builds,
  projects,
  screenshots,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";
import { objectKey, type Storage } from "@furan/storage";
import sharp from "sharp";

/**
 * The step seeds the per-step diff tests share (diff-step, step-job and
 * legacy-split): a project whose candidate run holds one screenshot per step,
 * each step with its own variation and, when baselined, its own baseline run.
 */

// The tile-aligned helper of handler.multi-checkpoint.test.ts and
// handler.layout.test.ts: a 400x400 white PNG with a 144px (3x3 tiles of 48px)
// square at (pos, pos), so a change produces real L1 clusters.
export const IMG = 400;
export const SQ = 144;
export const VP = "400x400";
export type Bbox = { x: number; y: number; width: number; height: number };

export async function square(
  color: "red" | "blue",
  pos: number,
): Promise<Buffer> {
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

export const elementMapBytes = (elements: Record<string, Bbox>): Buffer =>
  Buffer.from(JSON.stringify({ v: 1, elements, capturedAt: 0 }));

export interface StepSpec {
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

export interface ScenarioSpec {
  steps: StepSpec[];
  autoApproveFeature?: boolean;
  dynamicTextEnabled?: boolean;
  /** The candidate run's temp ignore areas (every step of the run). */
  tempIgnoreAreas?: unknown[];
  /** Selectors of enabled `auto_approve` rules. */
  ruleSelectors?: string[];
}

export interface Seeded {
  projectId: string;
  buildId: string;
  candidateRunId: string;
  /** Candidate screenshot id by step name. */
  shotId: Record<string, string>;
  variationId: Record<string, string>;
}

/**
 * Returns `seed(spec)`: one project per call, so two calls with one spec are
 * independent copies. Each step gets its own variation and baseline run (as in
 * handler.multi-checkpoint.test.ts); the candidate run (`running`, branch
 * `main`) holds one screenshot per step, in spec order, one second apart.
 * Every project created is pushed onto `projectIds` for the caller's cleanup.
 */
export function createStepSeeder(ctx: {
  db: DB;
  storage: Storage;
  userId: string;
  projectIds: string[];
}): (spec: ScenarioSpec) => Promise<Seeded> {
  const { db, storage, userId, projectIds } = ctx;
  return async function seed(spec: ScenarioSpec): Promise<Seeded> {
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

    return { projectId, buildId, candidateRunId, shotId, variationId };
  };
}
