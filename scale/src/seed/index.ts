import { randomBytes } from "node:crypto";

import { pendingStepCondition, type QueueAt } from "@furan/api/scale";
import {
  and,
  asc,
  builds,
  eq,
  inArray,
  projectMembers,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import { objectKey, type Storage } from "@furan/storage";
import bcrypt from "bcryptjs";

import { generateDiffPng, generatePng } from "./images.js";
import {
  DIFF_POOL,
  PIPELINE_SETS,
  SEED_NAMES,
  SHAPE_VERSION,
  diffImage,
  needsReseed,
  pipelineStep,
  poolImage,
  type PipelineSet,
  type Shape,
} from "./shape.js";
import {
  UPLOAD_CHUNK,
  inChunks,
  loadProject,
  resolveAllButOldest,
  vacuumAnalyze,
  wipe,
  type PipelineFixture,
  type PoolImage,
} from "./sql.js";
import { verifyStatuses } from "./verify.js";

export { SeedDriftError, verifyStatuses } from "./verify.js";
export {
  ScaleBusyError,
  ScaleDiskError,
  createScratch,
  type Scratch,
} from "./scratch.js";
export {
  SHAPE_VERSION,
  expectedRows,
  needsReseed,
  pipelineStep,
  shapes,
  type PipelineSet,
  type Shape,
  type ShapeName,
} from "./shape.js";
export {
  changeRect,
  generateDiffPng,
  generatePng,
  type ImageChange,
  type ImageKind,
  type PixelRect,
} from "./images.js";

export interface Seeded {
  projectId: string;
  /** The worst-case project: every recent batch resolved (old perf script). */
  resolvedProjectId: string;
  adminId: string;
  /** Reviewer members (`editor`); reviewer 0 has a password. */
  reviewers: { id: string }[];
  /** Reviewer 0's login. In memory only: never print it. */
  browserLogin: { email: string; password: string };
  /** The newest batch: the newest nightly, the review batch. */
  newestBuildId: string;
  /** The current long run and its own recent one-run batch. */
  longRunId: string;
  longRunBuildId: string;
  /** Step 1 of the long run (where the viewer is opened for R4 and D5). */
  longRunFirstStepId: string;
  /** Each set's variations on `main`, in step order (see `pipelineStep`). */
  pipeline: Record<PipelineSet, { variationIds: string[]; branch: "main" }>;
  /** Where the solo review-queue timings start (old perf script's cases). */
  soloSpots: {
    /** The middle pending step of the review batch. */
    mid: QueueAt;
    /** The review batch's last pending step. */
    last: QueueAt;
    /** The only pending step of a mid-aged PR batch. */
    exhausted: QueueAt;
    /** The worst-case project's newest kept pending step. */
    worstNewestKept: QueueAt;
  };
  /** An image key owned by exactly one screenshots row: long-run step 1's. */
  uniqueKeyProbe: string;
}

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

/** A hash no bcrypt compare accepts: the account cannot log in. */
const NO_LOGIN = "!scale-no-login";

/** The worst-case project keeps this share of its batches pending (old: 10 of 10,000). */
function keptPendingBatches(shape: Shape): number {
  return Math.max(1, Math.round((shape.nightlies + shape.prBatches) / 1000));
}

// ---------------------------------------------------------------------------
// scale_meta
// ---------------------------------------------------------------------------

async function metaTableExists(db: DB): Promise<boolean> {
  const [row] = await db.execute<{ t: string | null }>(
    sql`select to_regclass('public.scale_meta')::text as t`,
  );
  return Boolean(row?.t);
}

async function readMeta(
  db: DB,
): Promise<{ version: number; shape: string } | null> {
  if (!(await metaTableExists(db))) return null;
  const [row] = await db.execute<{ version: number; shape: string }>(
    sql`select shape_version as version, shape from scale_meta limit 1`,
  );
  return row ?? null;
}

async function writeMeta(db: DB, shape: Shape): Promise<void> {
  // Checked first: `create table if not exists` prints a server notice when
  // the table is there.
  if (!(await metaTableExists(db))) {
    await db.execute(sql`
      create table scale_meta (shape_version int not null, shape text not null)`);
  }
  await db.execute(sql`delete from scale_meta`);
  await db.execute(
    sql`insert into scale_meta (shape_version, shape) values (${SHAPE_VERSION}, ${shape.name})`,
  );
}

/**
 * Marks the seed used up, so the next `--reuse` reseeds it instead of
 * measuring it as it is. A suite calls it before it changes the review mix
 * for good: the server suite's approvals (R7) take the newest batch's pending
 * steps, which a reused seed would be missing (and `soloSpots` needs).
 */
export async function markSeedUsed(db: DB): Promise<void> {
  if (await metaTableExists(db)) await db.execute(sql`delete from scale_meta`);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Seeds `shape` into the scratch database behind `db` and its images into
 * `storage`, and returns what the suites need. With `reuse`, a database that
 * already holds this shape at the current `SHAPE_VERSION` is kept as it is
 * (only reviewer 0 gets a fresh password); anything else is wiped and
 * reseeded.
 *
 * Order: images (the pool, the diff images, the pipeline baselines), users
 * and projects, the main project, the worst-case
 * project, `vacuum analyze`, the worst case's resolution, `verifyStatuses` on
 * both projects, the spots, `scale_meta` (last, so an interrupted seed never
 * looks complete), and a final `vacuum analyze`.
 */
export async function seed(
  db: DB,
  shape: Shape,
  storage: Storage,
  opts: { reuse: boolean },
): Promise<Seeded> {
  const stored = await readMeta(db);
  const current =
    stored !== null &&
    stored.shape === shape.name &&
    !needsReseed(stored.version, SHAPE_VERSION);
  if (opts.reuse && current) {
    const password = newPassword();
    await setPassword(db, SEED_NAMES.reviewerEmail(0), password);
    return loadSeeded(db, shape, password);
  }

  await wipe(db);
  const [pool, diffPool, pipeline] = await Promise.all([
    uploadPool(shape, storage),
    uploadDiffPool(storage),
    uploadPipeline(shape, storage),
  ]);
  const password = newPassword();
  const ids = await seedUsersAndProjects(db, shape, password);
  const now = new Date();
  const common = {
    adminId: ids.adminId,
    shape,
    now,
    pool,
    diffPool,
    storage,
  };

  await loadProject(db, {
    ...common,
    projectId: ids.projectId,
    nightlies: shape.nightlies,
    prBatches: shape.prBatches,
    longRun: true,
    pipeline,
    uniqueImages: true,
    spanDays: shape.nightlies - 1,
  });
  // The old script's worst-case shape: as many batches as the main project
  // has nightlies and PR batches, the newest one full-size.
  await loadProject(db, {
    ...common,
    projectId: ids.resolvedProjectId,
    nightlies: 1,
    prBatches: shape.nightlies + shape.prBatches - 1,
    longRun: false,
    pipeline: [],
    uniqueImages: false,
    spanDays: shape.nightlies - 1,
  });
  // Statistics before the pending scan below (see resolveAllButOldest).
  await vacuumAnalyze(db);
  await resolveAllButOldest(
    db,
    ids.resolvedProjectId,
    ids.adminId,
    keptPendingBatches(shape),
  );

  await verifyStatuses(db, ids.projectId);
  await verifyStatuses(db, ids.resolvedProjectId);
  const seeded = await loadSeeded(db, shape, password);
  await writeMeta(db, shape);
  await vacuumAnalyze(db);
  return seeded;
}

function newPassword(): string {
  return randomBytes(24).toString("base64url");
}

async function setPassword(
  db: DB,
  email: string,
  password: string,
): Promise<void> {
  const updated = await db
    .update(users)
    .set({ hashedPassword: await bcrypt.hash(password, 10) })
    .where(eq(users.email, email))
    .returning({ id: users.id });
  if (updated.length !== 1) {
    throw new SeedError("--reuse: the scratch database has no browser user");
  }
}

/** The shared pool, uploaded once under content-addressed keys. */
async function uploadPool(
  shape: Shape,
  storage: Storage,
): Promise<PoolImage[]> {
  const indexes = Array.from({ length: shape.imagePool }, (_, i) => i);
  return inChunks(indexes, UPLOAD_CHUNK, async (i) => {
    const { kind, seed: imageSeed } = poolImage(shape, i);
    const png = await generatePng(kind, imageSeed, "none");
    const key = objectKey(png);
    await storage.put(key, png, "image/png");
    return { key, kind, png };
  });
}

/** The diff images every `unresolved` step shares, under content keys. */
async function uploadDiffPool(storage: Storage): Promise<PoolImage[]> {
  const indexes = Array.from({ length: DIFF_POOL }, (_, i) => i);
  return inChunks(indexes, UPLOAD_CHUNK, async (i) => {
    const { kind, seed: imageSeed } = diffImage(i);
    const png = await generateDiffPng(kind, imageSeed);
    const key = objectKey(png);
    await storage.put(key, png, "image/png");
    return { key, kind, png };
  });
}

/** Each pipeline step's baseline image (`none`), uploaded. */
async function uploadPipeline(
  shape: Shape,
  storage: Storage,
): Promise<PipelineFixture[]> {
  const fixtures: PipelineFixture[] = [];
  for (const set of PIPELINE_SETS) {
    const indexes = Array.from(
      { length: shape.pipelineSets[set] },
      (_, i) => i,
    );
    const steps = await inChunks(indexes, UPLOAD_CHUNK, async (i) => {
      const step = pipelineStep(set, i);
      const png = await generatePng(step.kind, step.seed, "none");
      const key = objectKey(png);
      await storage.put(key, png, "image/png");
      return { name: step.name, kind: step.kind, key };
    });
    fixtures.push({ set, steps });
  }
  return fixtures;
}

async function seedUsersAndProjects(
  db: DB,
  shape: Shape,
  password: string,
): Promise<{ adminId: string; projectId: string; resolvedProjectId: string }> {
  const [project] = await db
    .insert(projects)
    .values({ name: SEED_NAMES.project(shape) })
    .returning({ id: projects.id });
  const [resolved] = await db
    .insert(projects)
    .values({ name: SEED_NAMES.resolvedProject(shape) })
    .returning({ id: projects.id });
  const projectId = project!.id;
  const resolvedProjectId = resolved!.id;

  const [admin] = await db
    .insert(users)
    .values({
      email: SEED_NAMES.adminEmail,
      hashedPassword: NO_LOGIN,
      firstName: "Scale",
      lastName: "Admin",
      role: "admin",
      isActive: true,
      defaultProjectId: projectId,
    })
    .returning({ id: users.id });
  const hashed = await bcrypt.hash(password, 10);
  const reviewers = await db
    .insert(users)
    .values(
      Array.from({ length: shape.reviewers }, (_, i) => ({
        email: SEED_NAMES.reviewerEmail(i),
        hashedPassword: i === 0 ? hashed : NO_LOGIN,
        firstName: "Reviewer",
        lastName: String(i + 1),
        role: "editor" as const,
        isActive: true,
        defaultProjectId: projectId,
      })),
    )
    .returning({ id: users.id });

  const memberIds = [admin!.id, ...reviewers.map((r) => r.id)];
  await db
    .insert(projectMembers)
    .values(
      [projectId, resolvedProjectId].flatMap((pid) =>
        memberIds.map((userId) => ({ userId, projectId: pid })),
      ),
    );
  return { adminId: admin!.id, projectId, resolvedProjectId };
}

// ---------------------------------------------------------------------------
// What the suites get
// ---------------------------------------------------------------------------

async function projectNamed(db: DB, name: string): Promise<string> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.name, name));
  if (!row) throw new SeedError(`the scratch database has no project ${name}`);
  return row.id;
}

async function buildByCi(
  db: DB,
  projectId: string,
  ci: string,
): Promise<string> {
  const [row] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.projectId, projectId), eq(builds.ciBuildId, ci)));
  if (!row) throw new SeedError(`the seed has no batch ${ci}`);
  return row.id;
}

/** The pending steps of `projectId`, in capture order. */
export async function pendingSteps(db: DB, projectId: string) {
  return db
    .select({
      buildId: testRuns.buildId,
      runId: testRuns.id,
      checkpointId: screenshots.id,
    })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .innerJoin(builds, eq(builds.id, testRuns.buildId))
    .where(
      and(
        eq(testRuns.projectId, projectId),
        eq(screenshots.projectId, projectId),
        pendingStepCondition(),
      ),
    )
    .orderBy(
      asc(builds.createdAt),
      asc(builds.id),
      asc(testRuns.createdAt),
      asc(testRuns.id),
      asc(screenshots.createdAt),
      asc(screenshots.id),
    );
}

/**
 * The old script's spots (`findSpots` / `findResolvedSpots`): the middle and
 * last pending steps of the review batch; the only pending step of a mid-aged
 * batch, from which `findNext` finds nothing in its batch, wraps, finds
 * nothing either and opens the next batch (its longest path); and the
 * worst-case project's newest kept pending step.
 */
async function findSoloSpots(
  db: DB,
  ids: {
    projectId: string;
    resolvedProjectId: string;
    newestBuildId: string;
    longRunBuildId: string;
  },
): Promise<Seeded["soloSpots"]> {
  const pending = await pendingSteps(db, ids.projectId);
  const inNewest = pending.filter((p) => p.buildId === ids.newestBuildId);
  const perBuild = new Map<string, typeof pending>();
  for (const p of pending) {
    if (p.buildId === ids.newestBuildId || p.buildId === ids.longRunBuildId) {
      continue;
    }
    perBuild.set(p.buildId, [...(perBuild.get(p.buildId) ?? []), p]);
  }
  const singles = [...perBuild.values()].filter((v) => v.length === 1);
  const worst = await pendingSteps(db, ids.resolvedProjectId);
  if (inNewest.length < 3 || singles.length === 0 || worst.length === 0) {
    throw new SeedError("the seed has no usable pending steps");
  }
  const at = (p: (typeof pending)[number]): QueueAt => ({
    buildId: p.buildId,
    runId: p.runId,
    checkpointId: p.checkpointId,
  });
  return {
    mid: at(inNewest[Math.floor(inNewest.length / 2)]!),
    last: at(inNewest[inNewest.length - 1]!),
    exhausted: at(singles[Math.floor(singles.length / 2)]![0]!),
    worstNewestKept: at(worst[worst.length - 1]!),
  };
}

/** Builds `Seeded` from the seeded rows (fresh or reused). */
async function loadSeeded(
  db: DB,
  shape: Shape,
  password: string,
): Promise<Seeded> {
  const projectId = await projectNamed(db, SEED_NAMES.project(shape));
  const resolvedProjectId = await projectNamed(
    db,
    SEED_NAMES.resolvedProject(shape),
  );
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, SEED_NAMES.adminEmail));
  const reviewerEmails = Array.from({ length: shape.reviewers }, (_, i) =>
    SEED_NAMES.reviewerEmail(i),
  );
  const reviewerRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, reviewerEmails));
  const byEmail = new Map(reviewerRows.map((r) => [r.email, r.id]));
  const reviewers = reviewerEmails.map((email) => {
    const id = byEmail.get(email);
    if (!id) throw new SeedError("the scratch database is missing a reviewer");
    return { id };
  });
  if (!admin) throw new SeedError("the scratch database has no admin");

  const newestBuildId = await buildByCi(
    db,
    projectId,
    SEED_NAMES.newestNightly(shape),
  );
  const longRunBuildId = await buildByCi(
    db,
    projectId,
    SEED_NAMES.longRunBuild,
  );
  const [longRun] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.buildId, longRunBuildId));
  if (!longRun) throw new SeedError("the seed has no long run");

  const pipeline = {} as Seeded["pipeline"];
  for (const set of PIPELINE_SETS) {
    const names = Array.from(
      { length: shape.pipelineSets[set] },
      (_, i) => pipelineStep(set, i).name,
    );
    const rows = await db
      .select({ id: testVariations.id, name: testVariations.name })
      .from(testVariations)
      .where(
        and(
          eq(testVariations.projectId, projectId),
          eq(testVariations.branchName, "main"),
          inArray(testVariations.name, names),
        ),
      );
    const idByName = new Map(rows.map((r) => [r.name, r.id]));
    const variationIds = names.map((name) => {
      const id = idByName.get(name);
      if (!id) throw new SeedError(`the seed is missing ${set} steps`);
      return id;
    });
    pipeline[set] = { variationIds, branch: "main" };
  }

  const [probe] = await db
    .select({ id: screenshots.id, key: screenshots.imageKey })
    .from(screenshots)
    .where(
      and(
        eq(screenshots.runId, longRun.id),
        eq(screenshots.name, SEED_NAMES.longRunStep(1)),
      ),
    );
  if (!probe) throw new SeedError("the long run has no first step");

  const soloSpots = await findSoloSpots(db, {
    projectId,
    resolvedProjectId,
    newestBuildId,
    longRunBuildId,
  });

  return {
    projectId,
    resolvedProjectId,
    adminId: admin.id,
    reviewers,
    browserLogin: { email: SEED_NAMES.reviewerEmail(0), password },
    newestBuildId,
    longRunId: longRun.id,
    longRunBuildId,
    longRunFirstStepId: probe.id,
    pipeline,
    soloSpots,
    uniqueKeyProbe: probe.key,
  };
}
