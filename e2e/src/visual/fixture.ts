import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { ApiError, type ApiClient } from "../clients/api-client.js";
import {
  capture,
  captureRun,
  pollRunStatus,
  waitForCheckpointVerdicts,
  type Fixture,
} from "../clients/virtual-sdk.js";
import { API_URL } from "../env.js";
import { loadSeed, principal } from "../seed/load-seed.js";

import { uploadShots } from "./upload.js";

/**
 * The data the visual sweep's project-scoped routes render: one project with
 *
 *  - a build holding an UNRESOLVED run (a changed screenshot against an
 *    approved baseline), so the diff viewer, build and run pages all have real
 *    content; and
 *  - a build holding one MULTI-step run with a decided step on each side and a
 *    pending one, so step arrows, multi-step result rows and the decided states
 *    all render (see {@link addMultiRun}); and
 *  - a second pending batch of two runs on its own branch, one at a phone
 *    viewport, each with one pending changed step, so the review loop has a
 *    batch to continue to and the batch filters have more than one value (see
 *    {@link addLoopBatch});
 *
 * and, in a project of its own, a step whose baseline and current screenshot
 * differ in size (see {@link addMismatch}).
 */
export interface VisualFixture {
  projectId: string;
  buildId: string;
  unresolvedRunId: string;
  /** The multi-step run: home approved, cart rejected, profile pending `new`. */
  multiRunId: string;
  /** The build that run belongs to. */
  multiBuildId: string;
  /**
   * The loop batch: two runs (a desktop and a phone viewport), each with one
   * pending `changed` step. The newest batch of the project.
   */
  loopBuildId: string;
  /**
   * A step whose screenshots differ in size: its approved baseline is
   * 1280×800 and its current 1280×1100. In a project of its own (see
   * {@link addMismatch}).
   */
  mismatch: { runId: string; checkpointId: string; projectId: string };
}

type SingleFixture = Pick<
  VisualFixture,
  "projectId" | "buildId" | "unresolvedRunId"
>;
type MultiFixture = Pick<VisualFixture, "multiRunId" | "multiBuildId">;
type LoopFixture = Pick<VisualFixture, "loopBuildId">;
type MismatchFixture = Pick<VisualFixture, "mismatch">;

/**
 * What `.visual-sweep.json` can hold: the single-step ids, then each later
 * addition (the multi-step run, the loop batch, the size-mismatch step) once
 * it exists. A file from before an addition simply lacks it, and
 * {@link completeFixture} adds it.
 */
type StoredFixture = SingleFixture &
  Partial<MultiFixture> &
  Partial<LoopFixture> &
  Partial<MismatchFixture>;

const FIXTURE_FILE = fileURLToPath(
  new URL("../../.visual-sweep.json", import.meta.url),
);

/** Fixed name, so a `before` and an `after` run render the same project. */
const PROJECT_NAME = "visual-sweep";
const BUILD_NAME = "visual-sweep-build";
const CHECKPOINT = "home";
const BRANCH = "main";

/**
 * The multi-step run lives on its own branch: approving its `home` step makes
 * that screenshot the branch's baseline for `home`, which on `main` would
 * replace the baseline the single-step run above was diffed against.
 */
const MULTI_BRANCH = "visual-sweep-multi";
const MULTI_BASELINE_BUILD_NAME = "visual-sweep-multi-baseline";
const MULTI_BUILD_NAME = "visual-sweep-multi-build";

/**
 * The loop batch lives on its own branch too, for the same reason as the multi
 * run's: it must not touch the baselines of the other batches. Two tests, each
 * with one step: one at the default viewport, one at a phone's.
 */
const LOOP_BRANCH = "visual-sweep-loop";
const LOOP_BASELINE_BUILD_NAME = "visual-sweep-loop-baseline";
const LOOP_BUILD_NAME = "visual-sweep-loop-build";
const LOOP_TESTS: ReadonlyArray<{ name: string; viewport?: string }> = [
  { name: "loop-desktop" },
  { name: "loop-mobile", viewport: "375x812" },
];

/**
 * The size-mismatch step lives in a project of its own, so the sweep's
 * project keeps the loop batch as its newest batch (the `project`, `builds`
 * and `runs` routes land on it) and its batches table as it is. One step, its
 * baseline approved at one size and its current captured at another: 1280 px
 * wide both, 800 px tall, then 1100.
 */
const MISMATCH_PROJECT_NAME = "visual-sweep-mismatch";
const MISMATCH_BRANCH = "main";
const MISMATCH_BASELINE_BUILD_NAME = "visual-sweep-mismatch-baseline";
const MISMATCH_BUILD_NAME = "visual-sweep-mismatch-build";
const MISMATCH_CHECKPOINT = "size-mismatch";
const MISMATCH_WIDTH = 1280;
const MISMATCH_BASELINE_HEIGHT = 800;
const MISMATCH_CURRENT_HEIGHT = 1100;

const isId = (v: unknown): v is string => typeof v === "string" && v !== "";

/** A stored size-mismatch step, or null when it is not a whole one. */
function parseMismatch(raw: unknown): VisualFixture["mismatch"] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { runId, checkpointId, projectId } = raw as Record<string, unknown>;
  return isId(runId) && isId(checkpointId) && isId(projectId)
    ? { runId, checkpointId, projectId }
    : null;
}

/**
 * A parsed fixture file, validated field by field. A file from before the
 * multi-step run (or the loop batch, or the size-mismatch step) existed
 * lacks its ids: it is returned as such, and {@link completeFixture} adds
 * what is missing. A file that lacks a single-step id, or is no object at
 * all, is no fixture. (Exported so the upgrade rules can be driven without
 * the file.)
 */
export function parseFixture(raw: unknown): StoredFixture | null {
  // `null`, an array or a scalar parses fine but is no fixture either.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const {
    projectId,
    buildId,
    unresolvedRunId,
    multiRunId,
    multiBuildId,
    loopBuildId,
    mismatch: rawMismatch,
  } = raw as Record<string, unknown>;
  if (!isId(projectId) || !isId(buildId) || !isId(unresolvedRunId)) {
    return null;
  }
  // All three ids or none: a step is only found by all of them.
  const mismatch = parseMismatch(rawMismatch);
  return {
    projectId,
    buildId,
    unresolvedRunId,
    // Both or neither: half a pair is a run that cannot be rendered.
    ...(isId(multiRunId) && isId(multiBuildId)
      ? { multiRunId, multiBuildId }
      : {}),
    ...(isId(loopBuildId) ? { loopBuildId } : {}),
    ...(mismatch ? { mismatch } : {}),
  };
}

/** The fixture file, or null when it is missing, unreadable or no fixture. */
function readFixture(): StoredFixture | null {
  try {
    return parseFixture(JSON.parse(readFileSync(FIXTURE_FILE, "utf8")));
  } catch {
    return null;
  }
}

function writeFixture(fixture: StoredFixture): void {
  writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2));
}

/**
 * Reuse `e2e/.visual-sweep.json` while its project still exists on this stack
 * (so the `before` and `after` sweeps capture identical data); otherwise create
 * the fixture and write the file. Either way, the project is made the sweep
 * admin's default (see {@link makeAdminDefault}). Requires the Playwright
 * globalSetup seed.
 */
export async function ensureVisualFixture(
  api: ApiClient,
): Promise<VisualFixture> {
  const admin = loadSeed().bootstrapAdminJwt;
  const fixture = await reuseOrCreate(api);
  await makeAdminDefault(api, admin, fixture.projectId);
  return fixture;
}

/**
 * The sweep's admin session renders the project-less routes (`/inbox`) for its
 * CURRENT project, which is its default project. An admin sees every project,
 * so with no default and 2+ projects it has none, and `/inbox` would only ever
 * show "No project assigned" — the batches table, and its enforced contrast
 * check, would go unswept. Adds `projectId` to the admin's memberships (keeping
 * every existing one; `setUserProjects` replaces the whole set) and makes it
 * the default. A no-op when that is already so.
 */
async function makeAdminDefault(
  api: ApiClient,
  admin: string,
  projectId: string,
): Promise<void> {
  const me = await api.me(admin);
  const memberOf = await api.listUserProjects(admin, me.id);
  if (me.defaultProjectId === projectId && memberOf.includes(projectId)) return;
  await api.setUserProjects(admin, {
    userId: me.id,
    projectIds: [...new Set([...memberOf, projectId])],
    defaultProjectId: projectId,
  });
}

/**
 * The id of a new project called `name`, or of the one already called that:
 * a project can outlive its fixture file (deleted or stale), and is adopted.
 */
async function createOrAdoptProject(
  api: ApiClient,
  admin: string,
  name: string,
): Promise<string> {
  try {
    return (await api.createProject(admin, { name })).id;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) throw e;
    const found = (await api.listProjects(admin)).find((p) => p.name === name);
    if (!found) throw e;
    return found.id;
  }
}

async function reuseOrCreate(api: ApiClient): Promise<VisualFixture> {
  const seed = loadSeed();
  const admin = seed.bootstrapAdminJwt;
  const pat = principal(seed, "owner").pat;

  const existing = readFixture();
  if (existing) {
    const projects = await api.listProjects(admin);
    if (projects.some((p) => p.id === existing.projectId)) {
      return completeFixture(api, existing);
    }
  }

  const projectId = await createOrAdoptProject(api, admin, PROJECT_NAME);

  const base = await capture(api, {
    pat,
    projectId,
    branchName: BRANCH,
    checkpointName: CHECKPOINT,
    fixture: "baseline",
    buildName: BUILD_NAME,
  });
  // An adopted project may already hold this baseline, so the capture comes
  // back "passed"; only a new or unresolved run needs (and accepts) approval.
  if (base.status !== "passed") await api.approveRun(admin, base.runId);
  const changed = await capture(api, {
    pat,
    projectId,
    branchName: BRANCH,
    checkpointName: CHECKPOINT,
    fixture: "changed",
    buildName: BUILD_NAME,
  });
  if (changed.status !== "unresolved") {
    throw new Error(
      `visual fixture: expected the changed capture to be unresolved, got "${changed.status}"`,
    );
  }

  // Written before the rest is added, so a run that fails part-way resumes
  // from here instead of capturing the single-step run again.
  const stored: StoredFixture = {
    projectId,
    buildId: changed.buildId,
    unresolvedRunId: changed.runId,
  };
  writeFixture(stored);
  return completeFixture(api, stored);
}

/**
 * `stored` with whatever it lacks added: the multi-step run, then the loop
 * batch, then the size-mismatch step. A fixture file from before any of them:
 * keep the project and everything it already holds exactly as it is, and add
 * only the missing parts, writing the file after each so a failure part-way
 * never adds one twice. The loop batch is the last batch added to the
 * project, so it is always its newest batch (the `project`, `builds` and
 * `runs` routes land on the newest batch); the size-mismatch step is in a
 * project of its own, and is added again if that project is gone.
 */
async function completeFixture(
  api: ApiClient,
  stored: StoredFixture,
): Promise<VisualFixture> {
  const { projectId, buildId, unresolvedRunId } = stored;

  let multi: MultiFixture;
  if (stored.multiRunId !== undefined && stored.multiBuildId !== undefined) {
    multi = {
      multiRunId: stored.multiRunId,
      multiBuildId: stored.multiBuildId,
    };
  } else {
    multi = await addMultiRun(api, projectId);
    writeFixture({ ...stored, ...multi });
  }

  let loop: LoopFixture;
  if (stored.loopBuildId !== undefined) {
    loop = { loopBuildId: stored.loopBuildId };
  } else {
    loop = await addLoopBatch(api, projectId);
    writeFixture({ ...stored, ...multi, ...loop });
  }

  let mismatch: MismatchFixture;
  if (
    stored.mismatch !== undefined &&
    (await projectExists(api, stored.mismatch.projectId))
  ) {
    mismatch = { mismatch: stored.mismatch };
  } else {
    mismatch = { mismatch: await addMismatch(api) };
    writeFixture({ ...stored, ...multi, ...loop, ...mismatch });
  }

  return {
    projectId,
    buildId,
    unresolvedRunId,
    ...multi,
    ...loop,
    ...mismatch,
  };
}

/** Whether the project `projectId` is still on this stack. */
async function projectExists(
  api: ApiClient,
  projectId: string,
): Promise<boolean> {
  const projects = await api.listProjects(loadSeed().bootstrapAdminJwt);
  return projects.some((p) => p.id === projectId);
}

/** A run's checkpoints as the reviewer reads them: `name → state`, in order. */
async function checkpointStates(
  api: ApiClient,
  auth: string,
  runId: string,
): Promise<Array<[name: string, state: string | null]>> {
  const { items } = await api.trpcQuery<{
    items: Array<{ name: string; state: string | null }>;
  }>(auth, "runs.listCheckpoints", { runId });
  return items.map((c) => [c.name, c.state]);
}

/**
 * Throw unless the run's steps are exactly `expected`: a fixture that quietly
 * came out different would make every later before/after comparison meaningless.
 * `what` says which steps, when ("the multi-step run's steps after capture").
 */
async function expectSteps(
  api: ApiClient,
  auth: string,
  runId: string,
  expected: Array<[string, string]>,
  what: string,
): Promise<void> {
  const actual = await checkpointStates(api, auth, runId);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `visual fixture: expected ${what} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * The multi-step run: a three-step test (home, cart, checkout) approved as the
 * baseline of {@link MULTI_BRANCH}, then re-run with `home` changed, `cart`
 * identical and a new `profile` step in place of `checkout` (it has no
 * baseline). `home` is then approved and `cart` rejected ("reject anyway": a
 * rejection is allowed on a passed step), leaving the run `failed` with an
 * approved step, a rejected step and a pending `new` step.
 */
async function addMultiRun(
  api: ApiClient,
  projectId: string,
): Promise<MultiFixture> {
  const seed = loadSeed();
  const admin = seed.bootstrapAdminJwt;
  const pat = principal(seed, "owner").pat;

  const baseline = await captureRun(api, {
    pat,
    projectId,
    branchName: MULTI_BRANCH,
    buildName: MULTI_BASELINE_BUILD_NAME,
    checkpoints: [
      { name: "home", fixture: "baseline" },
      { name: "cart", fixture: "baseline" },
      { name: "checkout", fixture: "baseline" },
    ],
  });
  // A leftover baseline on this branch makes the capture "passed"; only a new
  // or unresolved run needs (and accepts) approval.
  if (baseline.status !== "passed") await api.approveRun(admin, baseline.runId);

  const candidate = await captureRun(api, {
    pat,
    projectId,
    branchName: MULTI_BRANCH,
    buildName: MULTI_BUILD_NAME,
    checkpoints: [
      { name: "home", fixture: "changed" },
      { name: "cart", fixture: "identical" },
      { name: "profile", fixture: "baseline" },
    ],
  });
  await expectSteps(
    api,
    admin,
    candidate.runId,
    [
      ["home", "unresolved"],
      ["cart", "passed"],
      ["profile", "new"],
    ],
    "the multi-step run's steps after capture",
  );

  await api.trpcMutate(admin, "review.approve", {
    runId: candidate.runId,
    actionId: randomUUID(),
    checkpointIds: [candidate.checkpointIds["home"]!],
  });
  const rejected = await api.trpcMutate<{
    runs: Array<{ runId: string; status: string }>;
  }>(admin, "review.reject", {
    runId: candidate.runId,
    actionId: randomUUID(),
    checkpointIds: [candidate.checkpointIds["cart"]!],
  });
  const status = rejected.runs.find((r) => r.runId === candidate.runId)?.status;
  if (status !== "failed") {
    throw new Error(
      `visual fixture: expected the multi-step run to be failed once its cart step is rejected, got "${status}"`,
    );
  }
  await expectSteps(
    api,
    admin,
    candidate.runId,
    [
      ["home", "approved"],
      ["cart", "rejected"],
      ["profile", "new"],
    ],
    "the multi-step run's steps after review",
  );

  return { multiRunId: candidate.runId, multiBuildId: candidate.buildId };
}

/**
 * One batch of the loop fixture: a run for each of {@link LOOP_TESTS}, each
 * with its one step captured from `fixture`, appended to the same build (the
 * first run makes it, named `buildName`).
 */
async function captureLoopBatch(
  api: ApiClient,
  projectId: string,
  fixture: Fixture,
  buildName: string,
): Promise<{
  buildId: string;
  runs: Array<{ name: string; runId: string; status: string }>;
}> {
  const pat = principal(loadSeed(), "owner").pat;
  let buildId: string | undefined;
  const runs: Array<{ name: string; runId: string; status: string }> = [];
  for (const test of LOOP_TESTS) {
    const run = await captureRun(api, {
      pat,
      projectId,
      branchName: LOOP_BRANCH,
      ...(buildId === undefined ? { buildName } : { buildId }),
      ...(test.viewport ? { viewport: test.viewport } : {}),
      checkpoints: [{ name: test.name, fixture }],
    });
    buildId = run.buildId;
    runs.push({ name: test.name, runId: run.runId, status: run.status });
  }
  if (buildId === undefined) {
    throw new Error("visual fixture: the loop batch has no tests");
  }
  return { buildId, runs };
}

/**
 * The loop batch: two tests (a desktop and a phone viewport), each approved as
 * the baseline of {@link LOOP_BRANCH}, then re-run in one new build with the
 * `changed` screenshot. Each of its two runs is left with one pending
 * `unresolved` step, which nothing in the sweep decides: the batch is the next
 * batch to continue to, and a second set of filter values, and stays pending.
 *
 * Not atomic: a failure after the candidate build exists (a capture or the
 * check below) leaves it as an extra pending batch on {@link LOOP_BRANCH}, and
 * since the fixture file has no `loopBuildId` yet the next run adds the loop
 * batch again. Accepted: a stray pending batch costs nothing to the sweep.
 */
async function addLoopBatch(
  api: ApiClient,
  projectId: string,
): Promise<LoopFixture> {
  const admin = loadSeed().bootstrapAdminJwt;

  const baseline = await captureLoopBatch(
    api,
    projectId,
    "baseline",
    LOOP_BASELINE_BUILD_NAME,
  );
  for (const run of baseline.runs) {
    // A leftover baseline on this branch makes the capture "passed"; only a new
    // or unresolved run needs (and accepts) approval.
    if (run.status !== "passed") await api.approveRun(admin, run.runId);
  }

  const candidate = await captureLoopBatch(
    api,
    projectId,
    "changed",
    LOOP_BUILD_NAME,
  );
  for (const run of candidate.runs) {
    await expectSteps(
      api,
      admin,
      run.runId,
      [[run.name, "unresolved"]],
      `the loop batch's ${run.name} run's steps after capture`,
    );
  }

  return { loopBuildId: candidate.buildId };
}

/**
 * A screenshot of the size-mismatch step, `height` px tall and
 * {@link MISMATCH_WIDTH} wide: a header and three blocks in the top 800 px,
 * the same at every height, and below them, where the taller one has room, a
 * fourth block. So the two sizes differ only in what one has and the other
 * lacks.
 */
function mismatchPng(height: number): Promise<Buffer> {
  const w = MISMATCH_WIDTH;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}">` +
    `<rect width="${w}" height="${height}" fill="#ffffff"/>` +
    `<rect width="${w}" height="72" fill="#1e40ff"/>` +
    `<rect x="64" y="136" width="560" height="320" fill="#e5e7eb"/>` +
    `<rect x="688" y="136" width="528" height="320" fill="#fde68a"/>` +
    `<rect x="64" y="520" width="1152" height="200" fill="#bbf7d0"/>` +
    (height >= 1036
      ? `<rect x="64" y="864" width="1152" height="172" fill="#fecaca"/>`
      : "") +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Upload one screenshot of the size-mismatch step, `height` px tall, as the
 * one run of a new build on {@link MISMATCH_BRANCH} (through `uploadShots`,
 * as the sweep uploads its own shots), and wait until the diff pipeline has
 * settled it: its step has a verdict, and the run a status.
 */
async function uploadMismatch(
  api: ApiClient,
  projectId: string,
  buildName: string,
  height: number,
): Promise<{ runId: string; checkpointId: string; status: string }> {
  const pat = principal(loadSeed(), "owner").pat;
  const { runs } = await uploadShots({
    apiUrl: API_URL,
    pat,
    projectId,
    branch: MISMATCH_BRANCH,
    buildName,
    shots: [{ name: MISMATCH_CHECKPOINT, png: await mismatchPng(height) }],
  });
  const [run] = runs;
  if (!run) {
    throw new Error("visual fixture: the size-mismatch upload made no run");
  }
  await waitForCheckpointVerdicts(api, pat, run.runId, [run.checkpointId]);
  const { status } = await pollRunStatus(api, pat, run.runId);
  return { runId: run.runId, checkpointId: run.checkpointId, status };
}

/**
 * The size-mismatch step, in its own project ({@link MISMATCH_PROJECT_NAME}):
 * a 1280×800 screenshot approved as the baseline of {@link MISMATCH_BRANCH},
 * then a 1280×1100 one of the same step in a new build, which nothing in the
 * sweep decides.
 *
 * The step must have been compared with that baseline, so it is `unresolved`
 * or `passed`, never `new`. Which one is the diff engine's: odiff, the
 * projects' default, compares the baseline's area only, so a taller current
 * screenshot whose top matches the baseline is a match (a diff-engine issue
 * of its own). The viewer shows both the same way: what differs is the size.
 *
 * Not atomic, as {@link addLoopBatch} is not: a failure after the second
 * build exists leaves it in the project, and the next run adds the step
 * again (adopting the project and its baseline).
 */
async function addMismatch(api: ApiClient): Promise<VisualFixture["mismatch"]> {
  const admin = loadSeed().bootstrapAdminJwt;
  const projectId = await createOrAdoptProject(
    api,
    admin,
    MISMATCH_PROJECT_NAME,
  );

  const baseline = await uploadMismatch(
    api,
    projectId,
    MISMATCH_BASELINE_BUILD_NAME,
    MISMATCH_BASELINE_HEIGHT,
  );
  // A leftover baseline on this branch (an adopted project) makes the
  // capture "passed"; only a new or unresolved run needs (and accepts)
  // approval.
  if (baseline.status !== "passed") await api.approveRun(admin, baseline.runId);

  const current = await uploadMismatch(
    api,
    projectId,
    MISMATCH_BUILD_NAME,
    MISMATCH_CURRENT_HEIGHT,
  );
  const steps = await checkpointStates(api, admin, current.runId);
  const [only] = steps;
  if (
    steps.length !== 1 ||
    only?.[0] !== MISMATCH_CHECKPOINT ||
    (only[1] !== "unresolved" && only[1] !== "passed")
  ) {
    throw new Error(
      `visual fixture: expected the size-mismatch run's one step, ${JSON.stringify(MISMATCH_CHECKPOINT)}, to be compared with its baseline (unresolved or passed), got ${JSON.stringify(steps)}`,
    );
  }
  return {
    runId: current.runId,
    checkpointId: current.checkpointId,
    projectId,
  };
}
