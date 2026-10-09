# Runbook — review model upgrade (per-checkpoint review)

This release changes how Furan reviews a run. A run used to be approved or
rejected **as a whole**. Now every checkpoint (every `snapshot()` step of a test)
has its own result and its own review decision, and the run's status is derived
from them. Three migrations move existing data onto the new model, and one
read-only CLI, `verify-review-rollup`, proves that nothing changed status along
the way.

**Scope:** every install upgrading from a release before the review model
(migrations `0035`–`0037`). Fresh installs have nothing to convert; the CLI
simply reports `0 mismatches`.

## 1. What changes

| Before                                                                                            | After                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One status per run, written directly by the diff-worker and by every approve / reject path        | Each checkpoint has a **verdict** (`new`, `passed` or `unresolved`; `screenshots.verdict`) from the diff against **its own** baseline                                                                                                                              |
| Approve / reject acted on the run; run-level approve promoted one arbitrary checkpoint's baseline | Reviewers **approve or reject checkpoints**. Each decision is a row in `checkpoint_decisions`, an append-only log                                                                                                                                                  |
| "Force passed / Force failed" overwrote the status                                                | It is stored separately (`test_runs.status_override`); "Reset to computed" clears it                                                                                                                                                                               |
| Any code path could write `test_runs.status`                                                      | The status is a **rollup**: `aborted` and `empty` stay as they are; an override wins; any checkpoint not diffed yet → `running`; otherwise the worst of each checkpoint's decision or verdict (`failed` > `unresolved` > `new` > `passed`). One function writes it |

The migrations, applied in order by the `migrate` one-shot before the apps start:

| Migration              | Kind             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0035_review_model`    | schema, additive | New enums, the nullable `screenshots.verdict` / `verdict_at` and `test_runs.status_override` columns, the empty `checkpoint_decisions` table (with row-level-security policy).                                                                                                                                                                                                                                                                               |
| `0036_baseline_repair` | data             | **Baseline repair.** Run-level approve used to promote one checkpoint per run, so steps 2…N of multi-step tests have no baseline, or a stale one. For each variation and branch, the most recently accepted run with a screenshot of it (`status = 'passed'` and `merge = true`) becomes its baseline when that acceptance is newer than the variation's current baseline, or when it has none. Each row written is audited as `baseline.repair` (no actor). |
| `0037_review_backfill` | data             | **Backfill.** Derives a verdict for every screenshot of a finished run (not `running`, `aborted` or `empty`), and records the old review as a decision: `approved` on the non-passed checkpoints of a `passed` run, `rejected` on those of a `failed` run (on every checkpoint when all of them passed, as for a force-failed run). It writes **no status**.                                                                                                 |

How `0037` derives a checkpoint's verdict, in order:

1. `unresolved` if the checkpoint has a diff region that counts (severity other than `none`, not resolved by an auto rule);
2. `new` if the run is `new`;
3. `unresolved` if the run is `unresolved` and none of its checkpoints has such a region (the run was unresolved as a whole);
4. otherwise `passed`.

So in an old unresolved run, only the checkpoints with differences are left to
review; the others count as passed.

Decisions recorded by the backfill:

- name the reviewer when the data still knows them: for approvals, the approver
  recorded on the run's baselines; for rejections, the newest reject in the
  audit log, if that user still exists. Otherwise they have no reviewer;
- are labelled "recorded before review history" and **cannot be undone**.
  They have no undo snapshot (`source = 'backfill'`, `before` is NULL).

## 2. Before you upgrade

1. **Snapshot the database.** See [`restore-from-backup.md`](./restore-from-backup.md).
2. **Stop the writers while the migrations run (recommended).** On a plain
   `docker compose up -d`, the previous release keeps serving while `migrate`
   runs. A review or a diff it completes in that window is written the old way,
   after the backfill has already passed over that run. Follow
   [`migration-deploy-order.md` §2](./migration-deploy-order.md#2-procedure--single-host-compose-default-install)
   (stop `api` and the workers, drain the queues, run `migrate`, start the new
   images) to close that window. If you skip it, §5 covers the gap.
3. **Optional: preview on a copy.** Restore the snapshot into a scratch
   database, run the new release's migrations against it, then run the CLI
   (§4) against it with `--repairs`. It lists exactly what `0036` will repair
   and confirms the backfill leaves every status as it was.

**How long it takes.** Both data migrations are set-based. `0037` took about
35 s for 1,000,050 screenshots in 102,045 runs (PostgreSQL 17, Docker Desktop
on macOS). That time is dominated by writing the verdicts; expect roughly
linear scaling with the screenshot count.

## 3. During the upgrade

The `migrate` one-shot applies the migrations. Each data migration reports
what it wrote:

```bash
P="docker compose -p docker --env-file infra/docker/.env -f infra/docker/compose.yml"

docker logs docker-migrate-1 2>&1 | grep -E 'NOTICE: +00(36|37)_'
# psql:/migrations/0036_baseline_repair.sql:…: NOTICE:  0036_baseline_repair: 12 baseline(s) repaired
# psql:/migrations/0037_review_backfill.sql:…: NOTICE:  0037_review_backfill: 918450 verdict(s) set, 25500 legacy approval(s), 25500 legacy rejection(s)
```

## 4. Verify: `verify-review-rollup`

The CLI recomputes the status of every finished run (all but `running`) from
its verdicts, its active decisions and its override, and prints each run whose
stored status differs. It **only reads**: every query runs in a read-only
transaction. It needs the api's environment (`DATABASE_URL` for the owner role,
`JWT_SECRET`), so run it as a one-off api container:

```bash
# Every project.
$P run --rm --no-deps api apps/api/dist/cli/verify-review-rollup.js
# One project.
$P run --rm --no-deps api apps/api/dist/cli/verify-review-rollup.js --project <project-uuid>
# Also list what 0036 repaired (the baseline.repair audit rows), oldest first.
$P run --rm --no-deps api apps/api/dist/cli/verify-review-rollup.js --repairs
```

The one-file install (`furan-compose.yml`) takes the same arguments:
`docker compose -f furan-compose.yml run --rm --no-deps api apps/api/dist/cli/verify-review-rollup.js`.
From a source checkout, with the api's `.env` loaded:
`pnpm --filter @furan/api exec tsx src/cli/verify-review-rollup.ts`.

Healthy output, exit code `0`:

```
0 mismatches
```

With mismatches, exit code `1`:

```
run_id, stored, computed
3f2a…, passed, unresolved
1 mismatch
```

`--repairs` first prints `baseline repairs (migration 0036): <count>`, then one
line per repaired baseline: its audit id, the time, and `variationId`, `runId`,
`branch`, `previousBaselineId` (the baseline it superseded, or null) and `op`
(`inserted`, or `updated` for a row moved onto the branch). The check follows.
With `--project`, only repairs whose run belongs to that project are listed.

| Exit code | Meaning                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `0`       | No mismatches.                                                                                            |
| `1`       | Mismatches, listed above the count; or an error, printed on stderr (for example, an invalid environment). |
| `2`       | Usage error: an unknown option, a positional argument, or a `--project` value that is not a uuid.         |

## 5. If the CLI reports mismatches

**Reviews or diffs from the previous release during the rollout window** (§2
step 2). This is the usual cause: the previous release wrote a status but no
verdict or decision. Re-run the backfill. It is idempotent and fills only the
gaps: verdicts that are still NULL, and decisions for `passed` / `failed` runs
that have none. It never changes a verdict, a decision or a status that
already exists.

```bash
$P run --rm --no-deps --entrypoint psql migrate \
  -v ON_ERROR_STOP=1 -f /migrations/0037_review_backfill.sql
# then run the CLI again
```

(For `furan-compose.yml`, use the same command with
`docker compose -f furan-compose.yml`.)

**Anything still listed** is a run whose stored status the old data cannot
explain. For example, the previous release approved a run after the backfill
had already recorded a rejection on it. Open the run in the dashboard and
settle its status with **Force passed** / **Force failed**, which sets the
override. Re-run the CLI to confirm.

## 6. The first build after the upgrade

Each checkpoint is now diffed against **its own** baseline. Before, every
checkpoint of a run was paired with one baseline run by viewport, so later
steps of a multi-step test could be compared with the wrong image. The first
build after the upgrade may therefore show **real differences** that the old
pairing hid. That is expected and correct: review them like any other
difference, checkpoint by checkpoint.

The `0036` repair gives each step the baseline the reviewer believed they had
approved, so multi-step tests do not suddenly report "no baseline". A step
that was **never** approved still has no baseline and shows as `new`, as
before.

## 7. Rolling back

- **The schema change is additive** (new enums, nullable columns, a new
  table). The previous release's images run against it unchanged: they ignore
  verdicts, decisions and the override.
- **Reviews made while rolled back** write the status the old way. After
  upgrading again, run the CLI and, if it lists them, re-run the backfill (§5).
- **Repaired baselines stay.** They are ordinary baselines, the ones the
  reviewers approved, and the previous release reads them as such.
- **Decisions recorded by the backfill cannot be undone**, by design: they
  have no undo snapshot. A run's status can still be set with Force passed /
  Force failed.
- **A full rollback** means restoring the pre-upgrade snapshot
  ([`restore-from-backup.md`](./restore-from-backup.md)). Everything written
  since the snapshot is lost.

## 8. References

- [`migration-deploy-order.md`](./migration-deploy-order.md) — stopping the writers while migrations run
- [`migration-conventions.md`](./migration-conventions.md) — expand / backfill / contract
- [`restore-from-backup.md`](./restore-from-backup.md) — snapshot and restore
- [`production-deploy.md`](./production-deploy.md) — the Compose install the commands above assume
- `packages/db/migrations/0036_baseline_repair.sql`, `0037_review_backfill.sql` — the exact rules, documented in their headers
