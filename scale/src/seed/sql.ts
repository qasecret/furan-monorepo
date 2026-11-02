import { buildHasPendingStep, pendingStepCondition } from "@furan/api/scale";
import {
  builds,
  COUNTERS_BACKFILL_SQL,
  screenshots,
  sql,
  testRuns,
  type DB,
  type SQL,
  type Tx,
} from "@furan/db";
import { SEVERITIES } from "@furan/shared-types";
import { objectKey, type Storage } from "@furan/storage";
import type { Sql } from "postgres";

import { withTextChunk, type ImageKind } from "./images.js";
import {
  SEED_BROWSER,
  SEED_NAMES,
  SEED_VIEWPORT,
  poolScreens,
  type PipelineSet,
  type Shape,
} from "./shape.js";

/**
 * The seed's set-based SQL (spec §3.2): `INSERT … SELECT generate_series`,
 * never one call per row. A project is staged in temp tables (batches, runs,
 * steps with their review class) inside one transaction, then written to the
 * real tables in capture order, so the physical order of the rows is the
 * order a real project would have written them in.
 *
 * Everything is deterministic: where the old perf script drew `random()`,
 * this hashes a step's position (`hashint8extended`), so a shape always seeds
 * the same mix, and the smoke shape's handful of steps is stable.
 */

/** Uploads run in chunks of this many concurrent `put`s. */
export const UPLOAD_CHUNK = 50;

/**
 * Distinct diff signatures (ADR-042) among a batch's changed steps, so
 * `runs.getCheckpointGroup` finds real groups of like changes (with no
 * signature it returns at once). Signatures are per batch.
 */
const SIGNATURES_PER_BATCH = 25;

/** Statement chunks for VALUES lists (well under the 65k parameter cap). */
const VALUES_CHUNK = 1000;

/** A shape value inlined into SQL; only ever an internal integer. */
function int(n: number): SQL {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`seed: expected an integer, got ${n}`);
  }
  return sql.raw(String(n));
}

function bool(b: boolean): SQL {
  return sql.raw(b ? "true" : "false");
}

/**
 * A deterministic, non-negative pseudo-random bigint for `key` (a bigint
 * expression), salted so each use draws independently.
 */
function h(key: SQL, salt: number): SQL {
  return sql`(hashint8extended((${key})::bigint, ${int(salt)}) & 9223372036854775807)`;
}

/**
 * Runs `fn` in one transaction with no statement timeout (the pool's 30 s
 * ceiling is for the app, not a bulk load) and room for the seed's sorts.
 */
export async function inTx<T>(db: DB, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = 0`);
    await tx.execute(sql`set local work_mem = '256MB'`);
    return fn(tx);
  });
}

/** The postgres.js client behind a `createDb` handle. */
function clientOf(db: DB): Sql {
  const client = (db as unknown as { $client?: Sql }).$client;
  if (!client || typeof client.reserve !== "function") {
    throw new Error("seed: the db handle must come from createDb()");
  }
  return client;
}

/**
 * `vacuum analyze` of the whole scratch database. VACUUM cannot run in a
 * transaction, so it runs on a reserved connection whose statement timeout is
 * lifted for it and restored before the connection goes back to the pool.
 */
export async function vacuumAnalyze(db: DB): Promise<void> {
  const conn = await clientOf(db).reserve();
  try {
    await conn`set statement_timeout = 0`;
    await conn`vacuum analyze`;
  } finally {
    try {
      await conn`reset statement_timeout`;
    } finally {
      conn.release();
    }
  }
}

/**
 * Every run's stored pending counters (`pending_steps` / `failed_steps`, spec
 * 2026-10-27 server reads §3.1), written once after the seed's last write. The
 * seed writes runs, steps and decisions in bulk SQL, not through
 * `recomputeRunStatus` (their one writer in the app), so until then they hold
 * the columns' default 0 and every counter read would see no pending work.
 *
 * It is migration 0043's backfill, `COUNTERS_BACKFILL_SQL`, as one statement
 * over the whole scratch database. That is right here, though never against a
 * live install: the seed is offline, and the app's stack starts only after it,
 * so no writer can race the statement's snapshot.
 */
export async function backfillRunCounters(db: DB): Promise<void> {
  await inTx(db, async (tx) => {
    await tx.execute(sql.raw(COUNTERS_BACKFILL_SQL));
  });
}

/** Empties every table of the scratch database (a previous seed included). */
export async function wipe(db: DB): Promise<void> {
  const rows = await db.execute<{ t: string }>(sql`
    select format('%I.%I', schemaname, tablename) as t
    from pg_tables where schemaname = 'public' order by 1`);
  if (rows.length === 0) return;
  await inTx(db, (tx) =>
    tx.execute(
      sql.raw(
        `truncate table ${rows.map((r) => r.t).join(", ")} restart identity cascade`,
      ),
    ),
  );
}

/** Runs `fn` over `items` in chunks of `size`, each chunk concurrently. */
export async function inChunks<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** One image of the shared pool, uploaded under its content key. */
export interface PoolImage {
  key: string;
  kind: ImageKind;
  png: Buffer;
}

/** One pipeline set's approved baseline steps (images already uploaded). */
export interface PipelineFixture {
  set: PipelineSet;
  steps: { name: string; kind: ImageKind; key: string }[];
}

/**
 * Uploads one object per row of `select` (rows of `key`, the step key, and
 * `idx`, the pool image to copy), built by `variant`, in chunks of
 * `UPLOAD_CHUNK`, and records each step's content key in `table`.
 */
async function uploadVariants(
  tx: Tx,
  storage: Storage,
  table: "seed_keys" | "seed_diff_keys",
  select: SQL,
  variant: (row: { key: string; idx: number }) => Buffer,
): Promise<number> {
  const rows = await tx.execute<{ key: string; idx: number }>(select);
  const values = await inChunks(rows, UPLOAD_CHUNK, async (row) => {
    const png = variant(row);
    const key = objectKey(png);
    await storage.put(key, png, "image/png");
    return sql`(${row.key}::bigint, ${key}::text)`;
  });
  for (let i = 0; i < values.length; i += VALUES_CHUNK) {
    await tx.execute(sql`
      insert into ${sql.identifier(table)} (step_key, image_key)
      values ${sql.join(values.slice(i, i + VALUES_CHUNK), sql`, `)}`);
  }
  return values.length;
}

export interface ProjectPlan {
  projectId: string;
  adminId: string;
  shape: Shape;
  /** Full-suite batches; the newest is the review batch. */
  nightlies: number;
  /** Small batches on the PR branches. */
  prBatches: number;
  /** Seed the long run: its earlier captures and its own recent batch. */
  longRun: boolean;
  /** Approved baseline runs, one per set, in the oldest nightly. */
  pipeline: PipelineFixture[];
  /**
   * Give each step of the review batch and of the current long run its own
   * object (a pool image with a `tEXt` chunk naming the step), so a key is
   * owned by exactly one row, and each `unresolved` one its own diff image
   * the same way, so a viewer stepping through them fetches every image as a
   * real run would. Otherwise every step uses the pools.
   */
  uniqueImages: boolean;
  /** Days from the oldest batch to the newest. */
  spanDays: number;
  /** The newest batch is a day before this. */
  now: Date;
  pool: PoolImage[];
  /**
   * Diff images (screens first, then pages), already uploaded: each
   * `unresolved` step's `diff_image_key`, by its variation's size. With
   * `uniqueImages`, the review batch's and the long run's `unresolved` steps
   * get their own copy instead (Ruling R10a).
   */
  diffPool: PoolImage[];
  storage: Storage;
}

/** Limits of the bigint step key `(build_no * 2048 + run) * 1024 + step`. */
const MAX_STEPS = 1023;
const MAX_RUNS = 2047;

function checkPlan(plan: ProjectPlan): void {
  const s = plan.shape;
  const steps = [
    s.nightlySteps,
    s.prSteps,
    s.longRunSteps,
    ...plan.pipeline.map((p) => p.steps.length),
  ];
  if (Math.max(...steps) > MAX_STEPS) {
    throw new Error(`seed: at most ${MAX_STEPS} steps per run`);
  }
  if (s.nightlyRuns + 2 + plan.pipeline.length > MAX_RUNS) {
    throw new Error(`seed: at most ${MAX_RUNS} runs per batch`);
  }
  if (plan.pipeline.length > 0 && plan.nightlies < 2) {
    throw new Error("seed: pipeline baselines need an earlier nightly");
  }
  for (const images of [plan.pool, plan.diffPool]) {
    const screens = images.filter((i) => i.kind === "screen").length;
    if (
      screens === 0 ||
      screens === images.length ||
      images.some((i, n) => (i.kind === "screen") !== n < screens)
    ) {
      throw new Error("seed: image pools hold screens first, then pages");
    }
  }
  if (s.prSteps > s.nightlySteps || s.nightlies < 1) {
    throw new Error("seed: PR runs capture a subset of the nightly steps");
  }
}

/**
 * Seeds one project in one transaction: its variations, batches, runs, steps
 * (with their verdicts and decisions), diff regions and baselines, and sets
 * each run's status as `recomputeRunStatus` would derive it.
 *
 * Batches, oldest first over `spanDays`:
 * - `nightlies` nightly batches on `main`, one a day, each holding every
 *   suite run (`nightlyRuns` x `nightlySteps`). The newest is the review
 *   batch. The earlier ones also hold one capture of the long run each (the
 *   most recent `longRunCaptures`), and the oldest holds one approved run per
 *   pipeline set (Ruling PF3).
 * - `prBatches` PR batches on `branch-<i % branches>` (parent `main`), each
 *   `prRuns` x `prSteps` of the suite, on branch-scoped variations (ADR-054).
 * - The current long run, in its own one-run batch an hour before the newest.
 *
 * Review classes:
 * - Earlier nightlies and long-run captures: decided or passed (decided where
 *   the hash bucket falls under pending + decided, so ~45%).
 * - PR batches: the old script's mix, per step: ~5% pending, ~40% decided,
 *   the rest passed; ~3% of the runs `running` (one undiffed step) or
 *   `aborted`. The middle PR batch is pinned to exactly one pending step (the
 *   queue's "only pending step of a batch" case), and its runs are
 *   reviewable.
 * - The review batch and the current long run: exact quotas, placed by hash:
 *   max(3, 5%) pending, 40% decided, the rest passed. In the review batch,
 *   max(1, 3%) of the runs without a pending step are not reviewable.
 * - Pipeline runs: every step `new` with an approval, and its baseline.
 *
 * Every step that did not pass (`new` / `unresolved`) gets 2-5 diff regions
 * and a diff signature shared with other changed steps of its batch. Every
 * `unresolved` step also gets a diff image (`diff_image_key`, from the diff
 * pool, sized like its screenshot), as the pixel diff writes one where it
 * found a change; a run holding one names one of them in `diff_name` (Ruling
 * R10).
 * Every decided step gets an active approval (the trigger keeps
 * `screenshots.has_active_decision`). A baseline is recorded for every step
 * of the suite and long-run captures on every `baselineEvery`-th earlier
 * night, and for every pipeline step.
 */
export async function loadProject(db: DB, plan: ProjectPlan): Promise<void> {
  checkPlan(plan);
  const s = plan.shape;
  const P = sql`${plan.projectId}::uuid`;
  const A = sql`${plan.adminId}::uuid`;
  const day = 24 * 60 * 60 * 1000;
  const t0 = new Date(plan.now.getTime() - (plan.spanDays + 1) * day);
  const T0 = sql`${t0.toISOString()}::timestamptz`;
  const span = int(plan.spanDays);
  const nightlies = int(plan.nightlies);
  const history = plan.longRun
    ? Math.max(0, Math.min(s.longRunHistory, plan.nightlies - 1))
    : 0;
  const pend = int(s.pendingPct);
  const pendDec = int(s.pendingPct + s.decidedPct);
  const pinned = int(Math.floor(plan.prBatches / 2));
  const screens = poolScreens(s);
  const pages = plan.pool.length - screens;
  const diffScreens = plan.diffPool.filter((d) => d.kind === "screen").length;
  const diffPages = plan.diffPool.length - diffScreens;
  const notReviewable = Math.max(
    1,
    Math.round((s.nightlyRuns * s.notReviewablePct) / 100),
  );
  const severities = SEVERITIES.filter((v) => v !== "none");
  const severityArray = sql`array[${sql.join(
    severities.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
  const { min: regionsMin, max: regionsMax } = s.regionsPerChangedStep;
  const runKey = (buildNo: SQL, k: SQL) =>
    sql`(${buildNo})::bigint * 2048 + ${k}`;

  await inTx(db, async (tx) => {
    // -- Batches -----------------------------------------------------------
    await tx.execute(sql`
      create temp table seed_builds on commit drop as
      select gen_random_uuid() as id, kind, idx, branch, ci, created_at,
             (row_number() over (order by created_at, kind, idx))::int as no
      from (
        select 'nightly' as kind, n as idx, 'main' as branch,
               'nightly-' || n as ci,
               ${T0} + (${span} - (${nightlies} - 1 - n)) * interval '1 day'
                 + interval '2 hours' as created_at
        from generate_series(0, ${nightlies} - 1) n
        union all
        select 'pr', i, 'branch-' || (i % ${int(s.branches)}), 'pr-' || i,
               ${T0} + (i::float8 * ${span} / ${int(Math.max(1, plan.prBatches))})
                 * interval '1 day'
        from generate_series(0, ${int(plan.prBatches)} - 1) i
        union all
        select 'long', 0, 'main', ${SEED_NAMES.longRunBuild}::text,
               ${T0} + ${span} * interval '1 day' + interval '1 hour'
        where ${bool(plan.longRun)}
      ) b`);

    // -- Variations (ADR-054: the branch is part of the identity) -----------
    await tx.execute(sql`
      create temp table seed_vars (
        id uuid not null default gen_random_uuid(),
        grp text not null, test int not null, step int not null,
        branch text not null, name text not null, kind text not null,
        image_key text
      ) on commit drop`);
    const suiteName = (t: SQL, st: SQL) =>
      sql`format('test-%s/step-%s', lpad((${t})::text, 4, '0'), ${st})`;
    const suiteKind = (t: SQL, st: SQL) =>
      sql`case when ${h(sql`(${t})::bigint * 1024 + ${st}`, 11)} % 10 < 7 then 'screen' else 'page' end`;
    await tx.execute(sql`
      insert into seed_vars (grp, test, step, branch, name, kind)
      select 'suite', t, st, 'main', ${suiteName(sql`t`, sql`st`)},
             ${suiteKind(sql`t`, sql`st`)}
      from generate_series(1, ${int(s.nightlyRuns)}) t,
           generate_series(1, ${int(s.nightlySteps)}) st`);
    // Each branch runs the same few suite tests in every PR batch.
    const prTest = (branchNo: SQL, k: SQL) =>
      sql`((${branchNo}) * ${int(s.prRuns)} + ${k} - 1) % ${int(s.nightlyRuns)} + 1`;
    await tx.execute(sql`
      insert into seed_vars (grp, test, step, branch, name, kind)
      select distinct 'suite', x.t, st, 'branch-' || b,
             ${suiteName(sql`x.t`, sql`st`)}, ${suiteKind(sql`x.t`, sql`st`)}
      from generate_series(0, least(${int(s.branches)}, ${int(plan.prBatches)}) - 1) b
      cross join generate_series(1, ${int(s.prRuns)}) k
      cross join lateral (select ${prTest(sql`b`, sql`k`)} as t) x
      cross join generate_series(1, ${int(s.prSteps)}) st`);
    if (plan.longRun) {
      await tx.execute(sql`
        insert into seed_vars (grp, test, step, branch, name, kind)
        select 'long', 0, st, 'main',
               format('crawl/page-%s', lpad(st::text, 4, '0')),
               case when ${h(sql`2000000 + st`, 11)} % 10 < 7
                    then 'screen' else 'page' end
        from generate_series(1, ${int(s.longRunSteps)}) st`);
    }
    for (const fixture of plan.pipeline) {
      for (let i = 0; i < fixture.steps.length; i += VALUES_CHUNK) {
        const rows = fixture.steps
          .slice(i, i + VALUES_CHUNK)
          .map(
            (step, j) =>
              sql`(${fixture.set}::text, 0, ${int(i + j + 1)}, 'main', ${step.name}::text, ${step.kind}::text, ${step.key}::text)`,
          );
        await tx.execute(sql`
          insert into seed_vars (grp, test, step, branch, name, kind, image_key)
          values ${sql.join(rows, sql`, `)}`);
      }
    }
    await tx.execute(sql`
      insert into test_variations
        (id, project_id, name, branch_name, browser, viewport, created_at, updated_at)
      select id, ${P}, name, branch, ${SEED_BROWSER}::text, ${SEED_VIEWPORT}::text, ${T0}, ${T0}
      from seed_vars order by grp, branch, test, step`);
    await tx.execute(sql`create index on seed_vars (grp, branch, test, step)`);
    await tx.execute(sql`analyze seed_vars`);

    // -- Runs ----------------------------------------------------------------
    await tx.execute(sql`
      create temp table seed_runs (
        id uuid not null default gen_random_uuid(),
        build_id uuid not null, build_no int not null, bkind text not null,
        bidx int not null, k int not null, grp text not null, test int not null,
        branch text not null, parent text, nsteps int not null, mix text not null,
        name text not null, created_at timestamptz not null,
        lifecycle text not null default 'done',
        baseline boolean not null default false
      ) on commit drop`);
    const lastNight = plan.nightlies - 1;
    const isBaselineNight = (idx: SQL) =>
      sql`(${idx} < ${int(lastNight)} and ${idx} % ${int(s.baselineEvery)} = 0)`;
    // Every nightly: the full suite. The newest is the review batch.
    await tx.execute(sql`
      insert into seed_runs (build_id, build_no, bkind, bidx, k, grp, test, branch,
                             nsteps, mix, name, created_at, baseline)
      select b.id, b.no, 'nightly', b.idx, k, 'suite', k, 'main',
             ${int(s.nightlySteps)},
             case when b.idx = ${int(lastNight)} then 'recent' else 'history' end,
             format('test-%s', lpad(k::text, 4, '0')),
             b.created_at + k * interval '1 second',
             ${isBaselineNight(sql`b.idx`)}
      from seed_builds b cross join generate_series(1, ${int(s.nightlyRuns)}) k
      where b.kind = 'nightly'`);
    // The long run's earlier captures: one in each of the latest earlier
    // nightlies.
    if (plan.longRun && history > 0) {
      await tx.execute(sql`
        insert into seed_runs (build_id, build_no, bkind, bidx, k, grp, test, branch,
                               nsteps, mix, name, created_at, baseline)
        select b.id, b.no, 'nightly', b.idx, ${int(s.nightlyRuns + 1)}, 'long', 0,
               'main', ${int(s.longRunSteps)}, 'history', ${SEED_NAMES.longRunName}::text,
               b.created_at + ${int(s.nightlyRuns + 1)} * interval '1 second',
               ${isBaselineNight(sql`b.idx`)}
        from seed_builds b
        where b.kind = 'nightly' and b.idx >= ${int(lastNight - history)}
          and b.idx < ${int(lastNight)}`);
    }
    // One approved run per pipeline set, in the oldest nightly.
    for (const [j, fixture] of plan.pipeline.entries()) {
      const k = int(s.nightlyRuns + 2 + j);
      await tx.execute(sql`
        insert into seed_runs (build_id, build_no, bkind, bidx, k, grp, test, branch,
                               nsteps, mix, name, created_at, baseline)
        select b.id, b.no, 'nightly', b.idx, ${k}, ${fixture.set}::text, 0, 'main',
               ${int(fixture.steps.length)}, 'approved', ${fixture.set}::text,
               b.created_at + ${k} * interval '1 second', true
        from seed_builds b where b.kind = 'nightly' and b.idx = 0`);
    }
    // PR batches. ~3% of their runs are not reviewable (never in the pinned
    // batch).
    const prRun = runKey(sql`b.no`, sql`k`);
    await tx.execute(sql`
      insert into seed_runs (build_id, build_no, bkind, bidx, k, grp, test, branch,
                             parent, nsteps, mix, name, created_at, lifecycle)
      select b.id, b.no, 'pr', b.idx, k, 'suite', x.t, b.branch, 'main',
             ${int(s.prSteps)},
             case when b.idx = ${pinned} then 'pinned' else 'mixed' end,
             format('test-%s', lpad(x.t::text, 4, '0')),
             b.created_at + k * interval '1 second',
             case when b.idx <> ${pinned}
                   and ${h(prRun, 21)} % 100 < ${int(s.notReviewablePct)}
                  then case when ${h(prRun, 22)} % 3 = 0 then 'aborted' else 'running' end
                  else 'done' end
      from seed_builds b
      cross join generate_series(1, ${int(s.prRuns)}) k
      cross join lateral (
        select ${prTest(sql`b.idx % ${int(s.branches)}`, sql`k`)} as t) x
      where b.kind = 'pr'`);
    // The current long run.
    await tx.execute(sql`
      insert into seed_runs (build_id, build_no, bkind, bidx, k, grp, test, branch,
                             nsteps, mix, name, created_at)
      select b.id, b.no, 'long', 0, 1, 'long', 0, 'main', ${int(s.longRunSteps)},
             'recent', ${SEED_NAMES.longRunName}::text, b.created_at + interval '1 second'
      from seed_builds b where b.kind = 'long'`);

    // -- Steps -----------------------------------------------------------------
    // The recent batches' exact quotas: each step's rank, by hash, in its batch.
    await tx.execute(sql`
      create temp table seed_rank on commit drop as
      select key,
             (row_number() over (partition by build_no order by ${h(sql`key`, 2)}, key) - 1)::int as rank,
             (count(*) over (partition by build_no))::int as n
      from (select r.build_no, (${runKey(sql`r.build_no`, sql`r.k`)}) * 1024 + st as key
            from seed_runs r cross join lateral generate_series(1, r.nsteps) st
            where r.mix = 'recent') x`);
    await tx.execute(sql`create index on seed_rank (key)`);
    const quotaPending = sql`greatest(3, round(rk.n * ${pend} / 100.0))`;
    const quotaDecided = sql`round(rk.n * ${int(s.decidedPct)} / 100.0)`;
    await tx.execute(sql`
      create temp table seed_steps on commit drop as
      select gen_random_uuid() as id, r.id as run_id, r.build_no, r.mix, r.k,
             st as step, k0.key, v.id as var_id, v.name, v.image_key as fixed_key,
             r.created_at + st * interval '10 milliseconds' as created_at,
             c.klass,
             case when c.klass in ('pending', 'decided')
                  then case when r.mix = 'approved' or ${h(sql`k0.key`, 3)} % 2 = 1
                            then 'new' else 'unresolved' end
                  else 'passed' end as verdict,
             (case when v.kind = 'screen'
                   then ${h(sql`k0.key`, 6)} % ${int(Math.max(1, screens))}
                   else ${int(screens)} + ${h(sql`k0.key`, 6)} % ${int(Math.max(1, pages))}
              end)::int as pool_idx,
             (case when v.kind = 'screen'
                   then ${h(sql`k0.key`, 8)} % ${int(diffScreens)}
                   else ${int(diffScreens)} + ${h(sql`k0.key`, 8)} % ${int(diffPages)}
              end)::int as diff_idx,
             (${bool(plan.uniqueImages)} and r.mix = 'recent') as uniq
      from seed_runs r
      cross join lateral generate_series(1, r.nsteps) st
      join seed_vars v
        on v.grp = r.grp and v.branch = r.branch and v.test = r.test and v.step = st
      cross join lateral (
        select (${runKey(sql`r.build_no`, sql`r.k`)}) * 1024 + st as key) k0
      cross join lateral (select ${h(sql`k0.key`, 1)} % 100 as bucket) hb
      left join seed_rank rk on rk.key = k0.key
      cross join lateral (select case r.mix
        when 'approved' then 'decided'
        when 'history' then
          case when hb.bucket < ${pendDec} then 'decided' else 'passed' end
        when 'mixed' then
          case when hb.bucket < ${pend} then 'pending'
               when hb.bucket < ${pendDec} then 'decided' else 'passed' end
        when 'pinned' then
          case when r.k = 1 and st = 1 then 'pending'
               when hb.bucket >= ${pend} and hb.bucket < ${pendDec} then 'decided'
               else 'passed' end
        when 'recent' then
          case when rk.rank < ${quotaPending} then 'pending'
               when rk.rank < ${quotaPending} + ${quotaDecided} then 'decided'
               else 'passed' end
        end as klass) c`);

    // Not reviewable in the review batch: max(1, 3%) of its runs, among
    // those without a pending step (so the review spots always exist).
    await tx.execute(sql`
      update seed_runs r
      set lifecycle = case when x.rn % 3 = 2 then 'aborted' else 'running' end
      from (
        select r2.id,
               (row_number() over (
                  order by ${h(runKey(sql`r2.build_no`, sql`r2.k`), 23)}, r2.k) - 1)::int as rn
        from seed_runs r2
        where r2.mix = 'recent' and r2.bkind = 'nightly'
          and not exists (select 1 from seed_steps s
                          where s.run_id = r2.id and s.klass = 'pending')
      ) x
      where r.id = x.id and x.rn < ${int(notReviewable)}`);
    // A running run's last step has not been diffed: no verdict yet.
    await tx.execute(sql`
      update seed_steps s set klass = 'undiffed', verdict = null
      from seed_runs r
      where r.id = s.run_id and r.lifecycle = 'running' and s.step = r.nsteps`);

    // -- Images ------------------------------------------------------------------
    await tx.execute(sql`
      create temp table seed_pool (idx int primary key, image_key text not null)
      on commit drop`);
    await tx.execute(sql`
      insert into seed_pool (idx, image_key) values ${sql.join(
        plan.pool.map((p, i) => sql`(${int(i)}, ${p.key}::text)`),
        sql`, `,
      )}`);
    await tx.execute(sql`
      create temp table seed_diff_pool (idx int primary key, image_key text not null)
      on commit drop`);
    await tx.execute(sql`
      insert into seed_diff_pool (idx, image_key) values ${sql.join(
        plan.diffPool.map((d, i) => sql`(${int(i)}, ${d.key}::text)`),
        sql`, `,
      )}`);
    await tx.execute(sql`
      create temp table seed_keys (step_key bigint primary key, image_key text not null)
      on commit drop`);
    await tx.execute(sql`
      create temp table seed_diff_keys (step_key bigint primary key, image_key text not null)
      on commit drop`);
    if (plan.uniqueImages) {
      // Named by shape and step position: the same seed writes the same
      // objects, so reseeding into the same storage overwrites them.
      const label = SEED_NAMES.project(s);
      await uploadVariants(
        tx,
        plan.storage,
        "seed_keys",
        sql`select key::text as key, pool_idx as idx from seed_steps
            where uniq order by key`,
        (row) => withTextChunk(plan.pool[row.idx]!.png, `${label}:${row.key}`),
      );
      await uploadVariants(
        tx,
        plan.storage,
        "seed_diff_keys",
        sql`select key::text as key, diff_idx as idx from seed_steps
            where uniq and verdict = 'unresolved' order by key`,
        (row) =>
          withTextChunk(
            plan.diffPool[row.idx]!.png,
            `${label}:diff:${row.key}`,
          ),
      );
    }

    // -- Rows, in capture order --------------------------------------------------
    await tx.execute(sql`
      insert into builds (id, ci_build_id, number, branch_name, project_id, user_id,
                          created_at, updated_at)
      select id, ci, no, branch, ${P}, ${A}, created_at, created_at
      from seed_builds order by no`);

    // The rollup (`rollupRunStatus`): aborted stays; an undiffed step makes the
    // run running; otherwise the worst effective state, an approval counting
    // as passed.
    await tx.execute(sql`
      insert into test_runs (id, build_id, project_id, name, status, branch_name,
                             parent_branch_name, created_at, updated_at,
                             checkpoint_count, completed_at, merge, diff_name)
      select r.id, r.build_id, ${P}, r.name, st.status::run_status, r.branch, r.parent,
             r.created_at, r.created_at, r.nsteps,
             case when st.status = 'running' then null
                  else r.created_at + r.nsteps * interval '10 milliseconds'
                         + interval '1 second' end,
             r.baseline, a.diff_name
      from seed_runs r
      join (
        select run_id, bool_or(verdict is null) as undiffed,
               max(case when klass = 'decided' then 0
                        when verdict = 'unresolved' then 2
                        when verdict = 'new' then 1 else 0 end) as worst,
               -- One of the run's diff images (the worker keeps its worst).
               min(case when verdict = 'unresolved'
                        then coalesce(dk.image_key, dp.image_key) end) as diff_name
        from seed_steps
        join seed_diff_pool dp on dp.idx = diff_idx
        left join seed_diff_keys dk on dk.step_key = key
        group by run_id
      ) a on a.run_id = r.id
      cross join lateral (select case
        when r.lifecycle = 'aborted' then 'aborted'
        when a.undiffed then 'running'
        when a.worst = 2 then 'unresolved'
        when a.worst = 1 then 'new'
        else 'passed' end as status) st
      order by r.created_at, r.k`);

    await tx.execute(sql`
      insert into screenshots (id, run_id, project_id, test_variation_id, name, viewport,
                               browser, image_key, verdict, verdict_at, diff_signature,
                               diff_image_key, created_at)
      select s.id, s.run_id, ${P}, s.var_id, s.name, ${SEED_VIEWPORT}::text,
             ${SEED_BROWSER}::text, coalesce(k.image_key, s.fixed_key, p.image_key),
             s.verdict::checkpoint_verdict,
             case when s.verdict is null then null
                  else s.created_at + interval '1 second' end,
             case when s.verdict in ('new', 'unresolved')
                  then 'v1:' || encode(sha256(convert_to(
                         'furan-scale:' || s.build_no || ':'
                           || ${h(sql`s.key`, 40)} % ${int(SIGNATURES_PER_BATCH)},
                         'UTF8')), 'hex') end,
             case when s.verdict = 'unresolved'
                  then coalesce(dk.image_key, dp.image_key) end,
             s.created_at
      from seed_steps s
      join seed_pool p on p.idx = s.pool_idx
      join seed_diff_pool dp on dp.idx = s.diff_idx
      left join seed_diff_keys dk on dk.step_key = s.key
      left join seed_keys k on k.step_key = s.key
      order by s.created_at, s.key`);

    // Approvals; the trigger sets screenshots.has_active_decision.
    await tx.execute(sql`
      insert into checkpoint_decisions (project_id, run_id, screenshot_id, action_id,
                                        decision, actor_id, source, created_at)
      select ${P}, run_id, id, gen_random_uuid(), 'approved', ${A}, 'viewer',
             created_at + interval '1 hour'
      from seed_steps where klass = 'decided' order by created_at, key`);

    const region = sql`s.key * 8 + g`;
    await tx.execute(sql`
      insert into diff_regions (run_id, project_id, screenshot_id, severity, category,
                                bbox, description, source, viewport, created_at)
      select s.run_id, ${P}, s.id,
             (${severityArray})[1 + (${h(region, 31)} % ${int(severities.length)})::int],
             (array['layout', 'color', 'text', 'image'])[1 + (${h(region, 32)} % 4)::int],
             jsonb_build_object(
               'x', ${h(region, 33)} % 1200, 'y', ${h(region, 34)} % 700,
               'width', 16 + ${h(region, 35)} % 150,
               'height', 8 + ${h(region, 36)} % 60),
             'Pixel difference', 'pixel', ${SEED_VIEWPORT}::text,
             s.created_at + interval '1 second'
      from seed_steps s
      cross join lateral generate_series(
        1, ${int(regionsMin)} + (${h(sql`s.key`, 30)} % ${int(regionsMax - regionsMin + 1)})::int) g
      where s.verdict in ('new', 'unresolved')
      order by s.created_at, s.key, g`);

    // Baselines: the step's image becomes its variation's baseline, approved
    // by the admin an hour after the capture.
    await tx.execute(sql`
      insert into baselines (baseline_name, test_variation_id, test_run_id, user_id,
                             branch_name, created_at, updated_at)
      select sc.image_key, sc.test_variation_id, sc.run_id, ${A}, 'main',
             sc.created_at + interval '1 hour', sc.created_at + interval '1 hour'
      from seed_runs r
      join screenshots sc on sc.run_id = r.id
      where r.baseline
      order by sc.created_at, sc.id`);
    // The variation's current baseline image (the viewer's baseline key).
    await tx.execute(sql`
      update test_variations v set baseline_name = x.baseline_name
      from (
        select distinct on (b.test_variation_id) b.test_variation_id, b.baseline_name
        from baselines b join seed_vars sv on sv.id = b.test_variation_id
        order by b.test_variation_id, b.created_at desc, b.id desc
      ) x
      where v.id = x.test_variation_id`);
    await tx.execute(sql`
      update projects set builds_counter = (select count(*) from seed_builds)
      where id = ${P}`);
    await tx.execute(sql`analyze`);
  });
}

/**
 * Each run's status as `rollupRunStatus` derives it from its steps' verdicts
 * and active decisions, for the runs of `projectId` whose stored status
 * differs. Lifecycle states (`aborted`, `empty`) and overridden runs are kept.
 */
function rollupStatuses(projectId: string): SQL {
  return sql`
    update test_runs r set status = x.status::run_status
    from (
      select s.run_id,
             case when bool_or(s.verdict is null) then 'running'
                  else case max(case when d.decision = 'rejected' then 3
                                     when d.id is not null then 0
                                     when s.verdict = 'unresolved' then 2
                                     when s.verdict = 'new' then 1 else 0 end)
                       when 3 then 'failed' when 2 then 'unresolved'
                       when 1 then 'new' else 'passed' end
             end as status
      from screenshots s
      left join checkpoint_decisions d
        on d.screenshot_id = s.id and d.reverted_at is null
      where s.project_id = ${projectId}::uuid
      group by s.run_id
    ) x
    where r.id = x.run_id and r.project_id = ${projectId}::uuid
      and r.status not in ('aborted', 'empty') and r.status_override is null
      and r.status::text <> x.status`;
}

/**
 * The worst case (old perf script): an approval for every pending step outside
 * the `keep` oldest batches that have one, then the runs' statuses rolled up
 * again. No recent batch is pending, while every resolved batch still holds
 * decided `new` / `unresolved` steps, so a probe for "the newest batch with a
 * pending step" has to look past nearly all of them. Run it after an analyze:
 * on never-analysed tables the planner can pick a per-build scan.
 */
export async function resolveAllButOldest(
  db: DB,
  projectId: string,
  actorId: string,
  keep: number,
): Promise<void> {
  await inTx(db, async (tx) => {
    await tx.execute(sql`
      insert into checkpoint_decisions (project_id, run_id, screenshot_id, action_id,
                                        decision, actor_id, source)
      select ${screenshots.projectId}, ${screenshots.runId}, ${screenshots.id},
             gen_random_uuid(), 'approved', ${actorId}::uuid, 'viewer'
      from ${screenshots}
      join ${testRuns} on ${testRuns.id} = ${screenshots.runId}
      where ${testRuns.projectId} = ${projectId}
        and ${screenshots.projectId} = ${projectId}
        and ${pendingStepCondition()}
        and ${testRuns.buildId} not in (
          select b.id from ${builds} b
          where b.project_id = ${projectId}
            and ${buildHasPendingStep(projectId, sql`b.id`)}
          order by b.created_at, b.id
          limit ${int(keep)})`);
    await tx.execute(rollupStatuses(projectId));
  });
}
