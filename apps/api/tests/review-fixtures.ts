import { randomUUID } from "node:crypto";

import {
  auditLog,
  baselines,
  builds,
  computeRunCounters,
  inArray,
  or,
  projectMembers,
  projects,
  recomputeRunStatus,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
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
  /**
   * The step's environment (ADR-038), also its variation's. Defaults: viewport
   * `1280x720`, browser `chromium`, no os, no device. The same `name` at two
   * viewports (or browsers, ...) is two steps of one run.
   */
  viewport?: string;
  browser?: string;
  os?: string;
  device?: string;
}

export interface ReviewRunSpec {
  checkpoints: ReviewCheckpointSpec[];
  /**
   * `test_runs.status`. Defaults to what the diff pipeline would have written:
   * the rollup of the verdicts (and the override, when set).
   */
  lifecycle?: RunStatus;
  override?: RunStatusOverride | null;
  /**
   * The run's id. Default: random. Pin it to make ids sort against capture
   * order, for a test of anything ordered by run id.
   */
  runId?: string;
}

export interface ReviewShot {
  id: string;
  variationId: string;
  imageKey: string;
  name: string;
  viewport: string;
  browser: string;
}

export interface ReviewRun {
  runId: string;
  /**
   * The run's steps by name. When one name is seeded at several environments
   * the first wins; use `shotsInOrder` for all of them.
   */
  shots: Record<string, ReviewShot>;
  /** Every step, in the spec's (capture) order. */
  shotsInOrder: ReviewShot[];
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
  /** The baseline run's own (earlier) build; null when none. */
  baselineBuildId: string | null;
  /** Every run seeded into this build (the first one and `addReviewRun`'s). */
  runIds: string[];
  /** The branch the seed's build and runs were created on. */
  branch: string;
  /** The builds `addReviewBuild` added to the project, with their runs. */
  extraBuilds: Array<{ buildId: string; branch: string; runIds: string[] }>;
  /** Editors `addProjectEditor` added to the project, besides `editor`. */
  peers: ReviewUser[];
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
  ctx: { projectId: string; buildId: string; tag: string; branch: string },
  spec: ReviewRunSpec,
  baselineRunId: () => Promise<string>,
): Promise<ReviewRun> {
  const override = spec.override ?? null;
  const checkpoints = spec.checkpoints.map((c) => ({
    verdict: c.verdict,
    decision: null,
    diffFailed: false,
  }));
  const lifecycle =
    spec.lifecycle ??
    rollupRunStatus({ lifecycle: "running", override, checkpoints });
  // The stored pending counters a writer would have left for these rows
  // (spec 2026-10-27 §3.1): no decision and no failed diff yet. The step
  // count too, as upload and complete keep it (`checkpoint_count`).
  const counters = computeRunCounters(
    { lifecycle, override, checkpoints },
    lifecycle,
  );
  const [run] = await h.db
    .insert(testRuns)
    .values({
      ...(spec.runId !== undefined ? { id: spec.runId } : {}),
      buildId: ctx.buildId,
      projectId: ctx.projectId,
      name: `run-${ctx.tag}`,
      status: lifecycle,
      statusOverride: override,
      branchName: ctx.branch,
      pendingSteps: counters.pendingSteps,
      failedSteps: counters.failedSteps,
      checkpointCount: spec.checkpoints.length,
      createdAt: nextCaptureTime(),
    })
    .returning({ id: testRuns.id });
  const runId = run!.id;

  const shots: Record<string, ReviewShot> = {};
  const shotsInOrder: ReviewShot[] = [];
  for (const c of spec.checkpoints) {
    const viewport = c.viewport ?? VIEWPORT;
    const browser = c.browser ?? BROWSER;
    const os = c.os ?? null;
    const device = c.device ?? null;
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
        branchName: ctx.branch,
        browser,
        viewport,
        os,
        device,
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
        branchName: ctx.branch,
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
        viewport,
        browser,
        os,
        device,
        imageKey,
        verdict: c.verdict,
        verdictAt: c.verdict === null ? null : capturedAt,
        createdAt: capturedAt,
      })
      .returning({ id: screenshots.id });
    const reviewShot: ReviewShot = {
      id: shot!.id,
      variationId,
      imageKey,
      name: c.name,
      viewport,
      browser,
    };
    shots[c.name] ??= reviewShot;
    shotsInOrder.push(reviewShot);
  }
  return { runId, shots, shotsInOrder };
}

/**
 * Seeds one project with four users, a build and one run whose checkpoints are
 * `spec.checkpoints` (in capture order). Each checkpoint gets its own
 * variation; `withBaseline` ones also get a baseline row on an earlier, passed
 * baseline run. `opts.branch` sets the branch of the build and its runs
 * (default `feature/review`).
 */
export async function seedReviewRun(
  h: TestApp,
  spec: ReviewRunSpec,
  opts: { branch?: string } = {},
): Promise<ReviewSeed> {
  const branch = opts.branch ?? BRANCH;
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
    .values({ projectId, userId: editor.id, branchName: branch })
    .returning({ id: builds.id });
  const buildId = build!.id;

  // The baseline run lives in its own, earlier build: it stands for the run
  // a previous approval promoted. Created lazily, only when needed.
  let baselineRunId: string | null = null;
  let baselineBuildId: string | null = null;
  const ensureBaselineRun = async (): Promise<string> => {
    if (baselineRunId) return baselineRunId;
    const [b] = await h.db
      .insert(builds)
      .values({ projectId, branchName: branch })
      .returning({ id: builds.id });
    baselineBuildId = b!.id;
    const [r] = await h.db
      .insert(testRuns)
      .values({
        buildId: baselineBuildId,
        projectId,
        name: `baseline-${tag}`,
        status: "passed",
        merge: true,
        branchName: branch,
        createdAt: nextCaptureTime(),
      })
      .returning({ id: testRuns.id });
    baselineRunId = r!.id;
    return baselineRunId;
  };
  if (spec.checkpoints.some((c) => c.withBaseline)) await ensureBaselineRun();

  const run = await insertRun(
    h,
    { projectId, buildId, tag, branch },
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
    baselineBuildId,
    runIds: [run.runId],
    branch,
    extraBuilds: [],
    peers: [],
    tag,
  };
  return seeded;
}

/**
 * Adds another editor to the seed's project: a member who is not the seed's
 * `editor`, for "someone else decided this" cases. Removed with the seed.
 */
export async function addProjectEditor(
  h: TestApp,
  seed: ReviewSeed,
): Promise<ReviewUser> {
  const label = `peer${seed.peers.length + 1}`;
  const peer = await seedUser(h, seed.tag, label, "editor");
  await h.db
    .insert(projectMembers)
    .values({ userId: peer.id, projectId: seed.projectId });
  seed.peers.push(peer);
  return peer;
}

/**
 * Adds another run (captured after every earlier one) to the seed's build, or
 * to `opts.buildId`: a build `addReviewBuild` created (the run takes that
 * build's branch). Checkpoint names already seeded in the project reuse their
 * variation (same branch only). `withBaseline` is not supported here: seed
 * baselines with `seedReviewRun`.
 */
export async function addReviewRun(
  h: TestApp,
  seed: ReviewSeed,
  spec: ReviewRunSpec,
  opts: { buildId?: string } = {},
): Promise<ReviewRun> {
  if (spec.checkpoints.some((c) => c.withBaseline)) {
    throw new Error("addReviewRun: seed baselines with seedReviewRun");
  }
  const buildId = opts.buildId ?? seed.buildId;
  const extra =
    buildId === seed.buildId
      ? undefined
      : seed.extraBuilds.find((b) => b.buildId === buildId);
  if (buildId !== seed.buildId && !extra) {
    throw new Error(
      "addReviewRun: buildId is neither the seed's build nor one addReviewBuild created",
    );
  }
  const run = await insertRun(
    h,
    {
      projectId: seed.projectId,
      buildId,
      tag: seed.tag,
      branch: extra?.branch ?? seed.branch,
    },
    spec,
    () => Promise.reject(new Error("unreachable")),
  );
  (extra?.runIds ?? seed.runIds).push(run.runId);
  return run;
}

/**
 * Adds another build to the seed's project (created after every earlier one),
 * on `opts.branch` (default: the seed's branch), holding one run built from
 * `opts.spec`. Like `addReviewRun`, `withBaseline` is not supported and names
 * already seeded in the project reuse their variation (same branch only: a
 * variation's identity includes its branch). Removed with the seed.
 */
export async function addReviewBuild(
  h: TestApp,
  seed: ReviewSeed,
  opts: { branch?: string; spec: ReviewRunSpec },
): Promise<ReviewRun & { buildId: string }> {
  if (opts.spec.checkpoints.some((c) => c.withBaseline)) {
    throw new Error("addReviewBuild: seed baselines with seedReviewRun");
  }
  const branch = opts.branch ?? seed.branch;
  const [build] = await h.db
    .insert(builds)
    .values({
      projectId: seed.projectId,
      userId: seed.editor.id,
      branchName: branch,
    })
    .returning({ id: builds.id });
  const buildId = build!.id;
  const run = await insertRun(
    h,
    { projectId: seed.projectId, buildId, tag: seed.tag, branch },
    opts.spec,
    () => Promise.reject(new Error("unreachable")),
  );
  seed.extraBuilds.push({ buildId, branch, runIds: [run.runId] });
  return { ...run, buildId };
}

/**
 * Brings the stored pending counters (`test_runs.pending_steps` /
 * `failed_steps`, spec 2026-10-27 §3) of `runIds` in line with their rows, by
 * recomputing each run through `recomputeRunStatus`, the app's one writer:
 * one transaction per run, in ascending id order (the lock order of every
 * multi-run writer).
 *
 * The seeds start with consistent counters, and every API write keeps them
 * so. A test that writes a run's inputs directly by SQL (a verdict or
 * `diff_failed_at`, a decision, an override, a step) and then reads anything
 * served from the counters must call this first. Like the app, it writes the
 * rollup status too, so a run seeded with a status that is not its rollup
 * gets the rollup. It does not touch `checkpoint_count`: a step added by SQL
 * must bump that itself.
 */
export async function syncRunCounters(
  db: DB,
  runIds: readonly string[],
): Promise<void> {
  for (const runId of [...new Set(runIds)].sort()) {
    await recomputeRunStatus(db, runId);
  }
}

/**
 * Removes exactly what the given seeds created: their projects (cascading to
 * builds, runs, variations, screenshots, baselines and decisions), their
 * users, and the audit rows about their runs and builds (run- and build-level
 * review actions) or written by their users (`audit_log` has no FKs, so
 * nothing cascades to it).
 */
export async function cleanupReviewSeeds(
  h: TestApp,
  seeds: ReadonlyArray<ReviewSeed>,
): Promise<void> {
  if (seeds.length === 0) return;
  const targetIds = seeds.flatMap((s) => [
    ...s.runIds,
    s.buildId,
    ...s.extraBuilds.flatMap((b) => [b.buildId, ...b.runIds]),
    ...(s.baselineRunId ? [s.baselineRunId] : []),
    ...(s.baselineBuildId ? [s.baselineBuildId] : []),
  ]);
  const userIds = seeds.flatMap((s) => [
    ...Object.values(s.users).map((u) => u.id),
    ...s.peers.map((u) => u.id),
  ]);
  await h.db
    .delete(auditLog)
    .where(
      or(
        inArray(auditLog.targetId, targetIds),
        inArray(auditLog.actorId, userIds),
      ),
    );
  await h.db.delete(projects).where(
    inArray(
      projects.id,
      seeds.map((s) => s.projectId),
    ),
  );
  await h.db.delete(users).where(inArray(users.id, userIds));
}
