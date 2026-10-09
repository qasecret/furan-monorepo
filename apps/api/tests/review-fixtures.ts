import { randomUUID } from "node:crypto";

import {
  auditLog,
  baselines,
  builds,
  inArray,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import {
  rollupRunStatus,
  type CheckpointVerdict,
  type RunStatus,
  type RunStatusOverride,
  type UserRole,
} from "@furan/shared-types";

import type { TestApp } from "./helpers.js";

/**
 * Shared seed for the review-flow suites (decision core, `review` router,
 * reads, legacy paths, backfill, revert). Every seed is self-contained: its
 * own project, users, build and variations, tagged with a random suffix so
 * seeds never collide, and `cleanupReviewSeeds` removes only what was seeded.
 */

export interface ReviewUser {
  id: string;
  /** A session JWT for the HTTP/tRPC suites. */
  jwt: string;
  email: string;
  role: UserRole;
  /** "First Last", what review errors report as `actorName`. */
  name: string;
}

export interface ReviewCheckpointSpec {
  /** Checkpoint (screenshot) name; also its variation's name. */
  name: string;
  /** NULL = not diffed yet. */
  verdict: CheckpointVerdict | null;
  /**
   * Give the variation an existing baseline: a `baselines` row on an earlier,
   * passed baseline run, and the variation's `baseline_name` pointing at it.
   */
  withBaseline?: boolean;
}

export interface ReviewRunSpec {
  checkpoints: ReviewCheckpointSpec[];
  /**
   * `test_runs.status`. Defaults to what the diff pipeline would have written:
   * the rollup of the verdicts (and the override, when set).
   */
  lifecycle?: RunStatus;
  override?: RunStatusOverride | null;
}

export interface ReviewShot {
  id: string;
  variationId: string;
  imageKey: string;
}

export interface ReviewRun {
  runId: string;
  shots: Record<string, ReviewShot>;
}

export interface ReviewSeed extends ReviewRun {
  projectId: string;
  buildId: string;
  /** The project's members: `editor` and `guest`. `admin` bypasses membership. */
  users: {
    editor: ReviewUser;
    admin: ReviewUser;
    guest: ReviewUser;
    outsider: ReviewUser;
  };
  editor: ReviewUser;
  admin: ReviewUser;
  guest: ReviewUser;
  outsider: ReviewUser;
  /** The earlier run that owns the `withBaseline` rows; null when none. */
  baselineRunId: string | null;
  /** Every run seeded into this build (the first one and `addReviewRun`'s). */
  runIds: string[];
  tag: string;
}

// Nobody logs in with a password in these suites; JWTs are signed directly.
const NO_LOGIN_HASH = "!review-fixture-no-login";
const BRANCH = "feature/review";
const VIEWPORT = "1280x720";
const BROWSER = "chromium";

/** Capture times are spaced 1s apart from a fixed past origin (deterministic order). */
let clock = Date.now() - 3_600_000;
function nextCaptureTime(): Date {
  clock += 1_000;
  return new Date(clock);
}

async function seedUser(
  h: TestApp,
  tag: string,
  label: string,
  role: UserRole,
): Promise<ReviewUser> {
  const firstName = label[0]!.toUpperCase() + label.slice(1);
  const lastName = `Rv${tag.slice(0, 6)}`;
  const email = `${label}-${tag}@review.example`;
  const [row] = await h.db
    .insert(users)
    .values({
      email,
      hashedPassword: NO_LOGIN_HASH,
      firstName,
      lastName,
      role,
      isActive: true,
    })
    .returning({ id: users.id });
  return {
    id: row!.id,
    jwt: h.app.jwt.sign({ sub: row!.id, role }),
    email,
    role,
    name: `${firstName} ${lastName}`,
  };
}

async function insertRun(
  h: TestApp,
  ctx: { projectId: string; buildId: string; tag: string },
  spec: ReviewRunSpec,
  baselineRunId: () => Promise<string>,
): Promise<ReviewRun> {
  const override = spec.override ?? null;
  const lifecycle =
    spec.lifecycle ??
    rollupRunStatus({
      lifecycle: "running",
      override,
      checkpoints: spec.checkpoints.map((c) => ({
        verdict: c.verdict,
        decision: null,
      })),
    });
  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: ctx.buildId,
      projectId: ctx.projectId,
      name: `run-${ctx.tag}`,
      status: lifecycle,
      statusOverride: override,
      branchName: BRANCH,
      createdAt: nextCaptureTime(),
    })
    .returning({ id: testRuns.id });
  const runId = run!.id;

  const shots: Record<string, ReviewShot> = {};
  for (const c of spec.checkpoints) {
    const baselineName = c.withBaseline
      ? `baseline-${c.name}-${ctx.tag}.png`
      : null;
    // One variation per checkpoint (identity includes the name). Re-seeding a
    // name into the same project reuses its variation, like a later CI run.
    const [variation] = await h.db
      .insert(testVariations)
      .values({
        projectId: ctx.projectId,
        name: c.name,
        branchName: BRANCH,
        browser: BROWSER,
        viewport: VIEWPORT,
        baselineName,
      })
      .onConflictDoUpdate({
        target: [
          testVariations.projectId,
          testVariations.name,
          testVariations.browser,
          testVariations.viewport,
          testVariations.branchName,
          testVariations.os,
          testVariations.device,
        ],
        set: { updatedAt: new Date() },
      })
      .returning({ id: testVariations.id });
    const variationId = variation!.id;
    if (c.withBaseline) {
      await h.db.insert(baselines).values({
        baselineName,
        testVariationId: variationId,
        testRunId: await baselineRunId(),
        branchName: BRANCH,
      });
    }
    const imageKey = `cap-${c.name}-${randomUUID()}.png`;
    const capturedAt = nextCaptureTime();
    const [shot] = await h.db
      .insert(screenshots)
      .values({
        runId,
        projectId: ctx.projectId,
        testVariationId: variationId,
        name: c.name,
        viewport: VIEWPORT,
        browser: BROWSER,
        imageKey,
        verdict: c.verdict,
        verdictAt: c.verdict === null ? null : capturedAt,
        createdAt: capturedAt,
      })
      .returning({ id: screenshots.id });
    shots[c.name] = { id: shot!.id, variationId, imageKey };
  }
  return { runId, shots };
}

/**
 * Seeds one project with four users, a build and one run whose checkpoints are
 * `spec.checkpoints` (in capture order). Each checkpoint gets its own
 * variation; `withBaseline` ones also get a baseline row on an earlier, passed
 * baseline run.
 */
export async function seedReviewRun(
  h: TestApp,
  spec: ReviewRunSpec,
): Promise<ReviewSeed> {
  const tag = randomUUID().slice(0, 8);
  const [project] = await h.db
    .insert(projects)
    .values({ name: `review-${tag}` })
    .returning({ id: projects.id });
  const projectId = project!.id;

  const editor = await seedUser(h, tag, "editor", "editor");
  const admin = await seedUser(h, tag, "admin", "admin");
  const guest = await seedUser(h, tag, "guest", "guest");
  const outsider = await seedUser(h, tag, "outsider", "editor");
  await h.db.insert(projectMembers).values([
    { userId: editor.id, projectId },
    { userId: guest.id, projectId },
  ]);

  const [build] = await h.db
    .insert(builds)
    .values({ projectId, userId: editor.id, branchName: BRANCH })
    .returning({ id: builds.id });
  const buildId = build!.id;

  // The baseline run lives in its own, earlier build: it stands for the run
  // a previous approval promoted. Created lazily, only when needed.
  let baselineRunId: string | null = null;
  const ensureBaselineRun = async (): Promise<string> => {
    if (baselineRunId) return baselineRunId;
    const [b] = await h.db
      .insert(builds)
      .values({ projectId, branchName: BRANCH })
      .returning({ id: builds.id });
    const [r] = await h.db
      .insert(testRuns)
      .values({
        buildId: b!.id,
        projectId,
        name: `baseline-${tag}`,
        status: "passed",
        merge: true,
        branchName: BRANCH,
        createdAt: nextCaptureTime(),
      })
      .returning({ id: testRuns.id });
    baselineRunId = r!.id;
    return baselineRunId;
  };
  if (spec.checkpoints.some((c) => c.withBaseline)) await ensureBaselineRun();

  const run = await insertRun(
    h,
    { projectId, buildId, tag },
    spec,
    ensureBaselineRun,
  );
  const seeded: ReviewSeed = {
    ...run,
    projectId,
    buildId,
    users: { editor, admin, guest, outsider },
    editor,
    admin,
    guest,
    outsider,
    baselineRunId,
    runIds: [run.runId],
    tag,
  };
  return seeded;
}

/**
 * Adds another run (captured after every earlier one) to the seed's build.
 * Checkpoint names already seeded in the project reuse their variation.
 * `withBaseline` is not supported here: seed baselines with `seedReviewRun`.
 */
export async function addReviewRun(
  h: TestApp,
  seed: ReviewSeed,
  spec: ReviewRunSpec,
): Promise<ReviewRun> {
  if (spec.checkpoints.some((c) => c.withBaseline)) {
    throw new Error("addReviewRun: seed baselines with seedReviewRun");
  }
  const run = await insertRun(
    h,
    { projectId: seed.projectId, buildId: seed.buildId, tag: seed.tag },
    spec,
    () => Promise.reject(new Error("unreachable")),
  );
  seed.runIds.push(run.runId);
  return run;
}

/**
 * Removes exactly what the given seeds created: their projects (cascading to
 * builds, runs, variations, screenshots, baselines and decisions), their
 * users, and the audit rows written about their runs.
 */
export async function cleanupReviewSeeds(
  h: TestApp,
  seeds: ReadonlyArray<ReviewSeed>,
): Promise<void> {
  if (seeds.length === 0) return;
  const runIds = seeds.flatMap((s) => [
    ...s.runIds,
    ...(s.baselineRunId ? [s.baselineRunId] : []),
  ]);
  const userIds = seeds.flatMap((s) => Object.values(s.users).map((u) => u.id));
  if (runIds.length > 0) {
    await h.db.delete(auditLog).where(inArray(auditLog.targetId, runIds));
  }
  await h.db.delete(projects).where(
    inArray(
      projects.id,
      seeds.map((s) => s.projectId),
    ),
  );
  await h.db.delete(users).where(inArray(users.id, userIds));
}
