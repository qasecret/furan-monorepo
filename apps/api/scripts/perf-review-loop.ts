/**
 * Review-loop performance harness (spec 2026-10-14-review-loop §4.2, ADR-073).
 *
 * Budget: `review.next` and the "needs review" list filters answer in p95 <
 * 50 ms on a 1,000-run batch inside a project with 10,000 batches. This script
 * seeds that shape into a scratch database, times each query 50 times and
 * prints p50 / p95, then drops the database.
 *
 * It is a throwaway measurement tool, NOT part of the test suite (vitest only
 * collects `tests/**`). It never touches the database it connects through:
 * it creates, fills and drops `furan_review_perf` on the same server.
 *
 *   pnpm --filter @furan/api exec tsx scripts/perf-review-loop.ts
 *
 * Needs `DATABASE_URL` (any database on the server; its host, port and
 * credentials are reused, its name is not). Flags:
 *   --keep   do not drop the scratch database at the end
 *   --reuse  use the scratch database as it is (it must exist and be seeded);
 *            migrations are still applied, so a new index is picked up
 *   --rls    time the queries again as the non-owner `furan_app` role, subject
 *            to row-level security (needs PERF_APP_PASSWORD, the role's login
 *            password)
 *
 * Shape: one project with 10,000 builds. The newest build has 1,000 runs of 5
 * steps; every other build has 3 runs of 3 steps. Of all steps about 5% are
 * pending, 40% were decided (they keep verdict `new` / `unresolved` and have an
 * active approval) and 55% passed; 3% of the runs are `running` (one undiffed
 * step) or `aborted`, so they are not reviewable.
 */
import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";

import {
  and,
  asc,
  builds,
  createDb,
  eq,
  projectMembers,
  projects,
  screenshots,
  sql,
  testRuns,
  users,
  withUserScope,
  type DB,
} from "@furan/db";
import { Registry } from "@furan/telemetry";

import { pendingStepCondition } from "../src/lib/review/pending.js";
import { findNext, type NextInput } from "../src/lib/review/queue.js";
import type { Context } from "../src/trpc/context.js";
import { appRouter } from "../src/trpc/v1/router.js";

const SCRATCH_DB = "furan_review_perf";
const MIN_FREE_GIB = 10;
const BUDGET_MS = 50;
const WARMUP = 5;
const CALLS = 50;

const BUILDS = 10_000;
const BIG_RUNS = 1_000;
const BIG_STEPS = 5;
const SMALL_RUNS = 3;
const SMALL_STEPS = 3;
const BRANCHES = 40;
/** Hash buckets of 100: [0,5) pending, [5,45) decided, [45,100) passed. */
const PENDING_PCT = 5;
const DECIDED_PCT = 40;

const flags = new Set(process.argv.slice(2));
const KEEP = flags.has("--keep");
const REUSE = flags.has("--reuse");
const RLS = flags.has("--rls");

/**
 * An error this script raises itself. Its message is fixed text that names no
 * connection detail, so it is printed as it is; any other error is not (see
 * `main`'s handler).
 */
class PerfError extends Error {}

/**
 * What is printed for an error that is not a `PerfError`: a driver or server
 * message can name the host, the port or a role, so only the error's class and
 * its code (a SQLSTATE such as `28P01`, or a system code such as
 * `ECONNREFUSED`) are shown.
 */
function fixedMessage(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  const code = (e as { code?: unknown } | null)?.code;
  const shown =
    typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code)
      ? ` ${code}`
      : "";
  return `perf-review-loop failed (${name}${shown})`;
}

function freeGiB(): number {
  const s = statfsSync("/");
  return (s.bavail * s.bsize) / 2 ** 30;
}

function urlFor(base: URL, database: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

function migrate(url: string): void {
  try {
    execFileSync(
      "pnpm",
      ["--filter", "@furan/db", "exec", "drizzle-kit", "migrate"],
      { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
  } catch (e) {
    // The child's output may name the connection; show the exit status only.
    const status = (e as { status?: number }).status;
    throw new PerfError(`drizzle-kit migrate failed (exit ${status ?? "?"})`);
  }
}

/** Drops the scratch database, if it exists (quietly: no server notice). */
async function dropScratch(admin: DB): Promise<void> {
  const found = await admin.execute(
    sql`select 1 from pg_database where datname = ${SCRATCH_DB}`,
  );
  if (found.length > 0) {
    await admin.execute(sql.raw(`drop database ${SCRATCH_DB} with (force)`));
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface Seeded {
  projectId: string;
  editorId: string;
}

async function seed(db: DB): Promise<Seeded> {
  const [project] = await db
    .insert(projects)
    .values({ name: "perf-review-loop" })
    .returning({ id: projects.id });
  const projectId = project!.id;
  const [editor] = await db
    .insert(users)
    .values({
      email: "editor@perf.example",
      hashedPassword: "!perf-no-login",
      firstName: "Perf",
      lastName: "Editor",
      role: "editor",
      isActive: true,
    })
    .returning({ id: users.id });
  const editorId = editor!.id;
  await db.insert(projectMembers).values({ userId: editorId, projectId });

  // 60 variations (20 names x 3 viewports); steps pick one at random.
  await db.execute(sql`
    insert into test_variations (project_id, name, browser, viewport)
    select ${projectId}::uuid, 'cp-' || n, 'chromium', vp
    from generate_series(0, 19) n,
         unnest(array['1280x720', '768x1024', '375x812']) vp`);
  await db.execute(sql`
    create table perf_variations as
    select row_number() over (order by name, viewport)::int as idx, id, viewport
    from test_variations where project_id = ${projectId}::uuid`);

  await db.execute(sql`
    insert into builds (ci_build_id, number, branch_name, project_id, user_id, created_at, updated_at)
    select 'ci-' || i, i + 1, 'branch-' || (i % ${BRANCHES}::int),
           ${projectId}::uuid, ${editorId}::uuid, ts, ts
    from (select i, now() - interval '30 days' + i * interval '3 minutes' as ts
          from generate_series(0, ${BUILDS - 1}::int) i) t`);

  await db.execute(sql`
    insert into test_runs (build_id, project_id, name, status, branch_name, created_at, updated_at, checkpoint_count)
    select b.id, b.project_id, 'run-' || b.number || '-' || g.k, 'passed', b.branch_name,
           b.created_at + g.k * interval '1 second',
           b.created_at + g.k * interval '1 second',
           case when b.number = ${BUILDS}::int then ${BIG_STEPS}::int else ${SMALL_STEPS}::int end
    from builds b
    cross join lateral generate_series(1, case when b.number = ${BUILDS}::int then ${BIG_RUNS}::int else ${SMALL_RUNS}::int end) as g(k)
    where b.project_id = ${projectId}::uuid`);

  // The steps, with the bucket (0-99) that decides pending / decided / passed.
  await db.execute(sql`
    create table perf_steps as
    select gen_random_uuid() as id, r.id as run_id, r.project_id, g.k,
           floor(random() * 100)::int as cls,
           1 + floor(random() * 60)::int as var_idx,
           r.created_at + g.k * interval '10 milliseconds' as created_at
    from test_runs r
    join builds b on b.id = r.build_id
    cross join lateral generate_series(1, case when b.number = ${BUILDS}::int then ${BIG_STEPS}::int else ${SMALL_STEPS}::int end) as g(k)
    where r.project_id = ${projectId}::uuid`);

  await db.execute(sql`
    insert into screenshots (id, run_id, project_id, test_variation_id, name, viewport, browser, image_key, verdict, verdict_at, created_at)
    select s.id, s.run_id, s.project_id, v.id, 'step-' || s.k, v.viewport, 'chromium',
           'perf/' || s.id || '.png',
           (case when s.cls >= ${PENDING_PCT + DECIDED_PCT}::int then 'passed'
                 when s.cls % 2 = 0 then 'unresolved' else 'new' end)::checkpoint_verdict,
           s.created_at, s.created_at
    from perf_steps s
    join perf_variations v on v.idx = s.var_idx`);

  await db.execute(sql`
    insert into checkpoint_decisions (project_id, run_id, screenshot_id, action_id, decision, actor_id, source)
    select s.project_id, s.run_id, s.id, gen_random_uuid(), 'approved', ${editorId}::uuid, 'viewer'
    from perf_steps s
    where s.cls >= ${PENDING_PCT}::int and s.cls < ${PENDING_PCT + DECIDED_PCT}::int`);

  // 3% of the runs are not reviewable: still running (one undiffed step) or aborted.
  await db.execute(sql`
    update test_runs
    set status = (case when random() < 0.667 then 'running' else 'aborted' end)::run_status
    where project_id = ${projectId}::uuid and random() < 0.03`);
  await db.execute(sql`
    update screenshots s set verdict = null, verdict_at = null
    from (select distinct on (run_id) id from screenshots
          where run_id in (select id from test_runs where status = 'running')
          order by run_id, created_at desc) x
    where s.id = x.id`);
  // A reviewable run with a pending step is `unresolved`, the rest stay `passed`.
  await db.execute(sql`
    update test_runs r set status = 'unresolved'
    where r.project_id = ${projectId}::uuid and r.status = 'passed'
      and exists (
        select 1 from screenshots s
        where s.run_id = r.id and s.verdict in ('new', 'unresolved')
          and not exists (select 1 from checkpoint_decisions d
                          where d.screenshot_id = s.id and d.reverted_at is null))`);

  await db.execute(sql`vacuum analyze`);
  return { projectId, editorId };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

interface Row {
  label: string;
  p50: number;
  p95: number;
  max: number;
  budgeted: boolean;
}

/** Nearest-rank percentile of an ascending sample. */
function pct(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

async function measure(
  label: string,
  fn: () => Promise<unknown>,
  budgeted = true,
): Promise<Row> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const ms: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  return {
    label,
    p50: pct(ms, 0.5),
    p95: pct(ms, 0.95),
    max: ms[ms.length - 1]!,
    budgeted,
  };
}

function print(title: string, rows: Row[]): void {
  console.log(`\n${title}`);
  console.log("| query | p50 ms | p95 ms | max ms | budget |");
  console.log("|---|---:|---:|---:|---|");
  for (const r of rows) {
    const verdict = !r.budgeted
      ? "(reference)"
      : r.p95 < BUDGET_MS
        ? "ok"
        : "OVER";
    console.log(
      `| ${r.label} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} | ${verdict} |`,
    );
  }
}

interface Spots {
  bigBuildId: string;
  mid: { buildId: string; runId: string; checkpointId: string };
  last: { buildId: string; runId: string; checkpointId: string };
  /**
   * The only pending step of a mid-aged small build. `findNext` finds nothing
   * after it in its batch, wraps and finds nothing before it either, so it
   * opens the next batch: the longest path, 5 statements (6 when no other
   * batch on its branch has a pending step and the any-branch probe runs too).
   */
  exhausted: { buildId: string; runId: string; checkpointId: string };
  pendingInBig: number;
  pendingBuilds: number;
  pendingSteps: number;
}

async function findSpots(db: DB, projectId: string): Promise<Spots> {
  const [big] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.projectId, projectId), eq(builds.number, BUILDS)));
  const bigBuildId = big!.id;

  const pending = await db
    .select({
      buildId: testRuns.buildId,
      runId: testRuns.id,
      checkpointId: screenshots.id,
      buildCreatedAt: builds.createdAt,
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
      asc(testRuns.createdAt),
      asc(testRuns.id),
      asc(screenshots.createdAt),
      asc(screenshots.id),
    );

  const inBig = pending.filter((p) => p.buildId === bigBuildId);
  const perBuild = new Map<string, typeof pending>();
  for (const p of pending) {
    if (p.buildId === bigBuildId) continue;
    perBuild.set(p.buildId, [...(perBuild.get(p.buildId) ?? []), p]);
  }
  const singles = [...perBuild.values()].filter((v) => v.length === 1);
  const pick = (p: (typeof pending)[number]) => ({
    buildId: p.buildId,
    runId: p.runId,
    checkpointId: p.checkpointId,
  });
  if (inBig.length < 3 || singles.length === 0) {
    throw new PerfError("the seed has no usable pending steps");
  }
  return {
    bigBuildId,
    mid: pick(inBig[Math.floor(inBig.length / 2)]!),
    last: pick(inBig[inBig.length - 1]!),
    exhausted: pick(singles[Math.floor(singles.length / 2)]![0]!),
    pendingInBig: inBig.length,
    pendingBuilds: new Set(pending.map((p) => p.buildId)).size,
    pendingSteps: pending.length,
  };
}

async function timeAll(
  db: DB,
  seeded: Seeded,
  spots: Spots,
  scoped: boolean,
): Promise<Row[]> {
  const { projectId, editorId } = seeded;
  const ctx = {
    user: { id: editorId, role: "editor", via: "jwt" },
    db,
    telemetry: { metrics: new Registry() },
  } as unknown as Context;
  const api = appRouter.createCaller(ctx);

  /** `findNext` on the plain handle, or in a user-scoped transaction (RLS). */
  const direct = (input: Omit<NextInput, "projectId">) =>
    scoped
      ? withUserScope(
          db,
          { userId: editorId, role: "editor", projectId },
          (tx) => findNext(tx, { projectId, ...input }),
        )
      : findNext(db, { projectId, ...input });

  const rows: Row[] = [];
  const cases = [
    ["at mid-batch (1,000-run batch)", { at: spots.mid }],
    ["no at", {}],
    ["at the batch's last pending step", { at: spots.last }],
    [
      "at the only pending step of a batch (findNext: 5 statements)",
      { at: spots.exhausted },
    ],
  ] as const;
  for (const [name, input] of cases) {
    rows.push(await measure(`findNext, ${name}`, () => direct(input)));
  }
  for (const [name, input] of cases) {
    rows.push(
      await measure(`review.next, ${name}`, () =>
        api.review.next({ projectId, ...input }),
      ),
    );
  }
  rows.push(
    await measure(`runs.list pending, order capture (1,000-run batch)`, () =>
      api.runs.list({
        projectId,
        buildId: spots.bigBuildId,
        pending: true,
        order: "capture",
      }),
    ),
    await measure(`builds.list needsReview`, () =>
      api.builds.list({ projectId, needsReview: true }),
    ),
    await measure(`builds.pendingCount (sidebar badge)`, () =>
      api.builds.pendingCount({ projectId }),
    ),
    await measure(
      `builds.list, no filter`,
      () => api.builds.list({ projectId }),
      false,
    ),
    await measure(
      `runs.list capture, no pending filter`,
      () =>
        api.runs.list({
          projectId,
          buildId: spots.bigBuildId,
          order: "capture",
        }),
      false,
    ),
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const free = freeGiB();
  console.log(`free disk on /: ${free.toFixed(1)} GiB`);
  if (free < MIN_FREE_GIB) {
    console.error(`less than ${MIN_FREE_GIB} GiB free on /; not seeding`);
    process.exitCode = 1;
    return;
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new PerfError("DATABASE_URL is not set");
  const base = new URL(raw);
  const scratchUrl = urlFor(base, SCRATCH_DB);

  const admin = createDb({ url: raw });
  let seeded: Seeded | undefined;
  try {
    if (!REUSE) {
      await dropScratch(admin.db);
      await admin.db.execute(sql.raw(`create database ${SCRATCH_DB}`));
    }
    migrate(scratchUrl);

    const scratch = createDb({ url: scratchUrl });
    try {
      if (REUSE) {
        const [p] = await scratch.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.name, "perf-review-loop"));
        const [u] = await scratch.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, "editor@perf.example"));
        if (!p || !u)
          throw new PerfError("--reuse: the scratch database is not seeded");
        seeded = { projectId: p.id, editorId: u.id };
      } else {
        const t0 = performance.now();
        seeded = await seed(scratch.db);
        console.log(
          `seeded in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
        );
      }
      const spots = await findSpots(scratch.db, seeded.projectId);
      console.log(
        `shape: ${BUILDS} builds, big batch ${BIG_RUNS} runs x ${BIG_STEPS} steps; ` +
          `pending: ${spots.pendingSteps} steps in ${spots.pendingBuilds} builds ` +
          `(${spots.pendingInBig} in the big batch)`,
      );
      const [counts] = await scratch.db.execute<{
        runs: number;
        steps: number;
        decisions: number;
      }>(sql`select
        (select count(*) from test_runs)::int as runs,
        (select count(*) from screenshots)::int as steps,
        (select count(*) from checkpoint_decisions)::int as decisions`);
      console.log(
        `rows: ${counts!.runs} runs, ${counts!.steps} steps, ${counts!.decisions} decisions`,
      );

      print(
        "owner connection (no RLS)",
        await timeAll(scratch.db, seeded, spots, false),
      );

      if (RLS) {
        const password = process.env.PERF_APP_PASSWORD;
        if (!password) throw new PerfError("--rls needs PERF_APP_PASSWORD");
        const appUrl = new URL(scratchUrl);
        appUrl.username = "furan_app";
        appUrl.password = password;
        const app = createDb({ url: appUrl.toString() });
        try {
          print(
            "furan_app connection (row-level security on)",
            await timeAll(app.db, seeded, spots, true),
          );
        } finally {
          await app.close();
        }
      }
    } finally {
      await scratch.close();
    }
  } finally {
    if (KEEP) {
      console.log(`\nkept ${SCRATCH_DB}`);
    } else {
      await dropScratch(admin.db);
      console.log(`\ndropped ${SCRATCH_DB}`);
    }
    await admin.close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e: unknown) => {
    console.error(e instanceof PerfError ? e.message : fixedMessage(e));
    process.exit(1);
  },
);
