# Runbook — server reads upgrade (migrations 0043 and 0044)

This release makes the review reads cheap on a large project. Each run now
stores how many of its steps still need review, so the review queue, the
pending counts and the "Needs review" filters no longer re-derive that across
the whole project. New indexes serve the batch and run lists, the viewer's
one-step read and the storage proxy's image access check. Two migrations add
them, and one CLI, `verify-review-rollup --repair-counters`, checks and
repairs the stored counts.

**Scope:** every install upgrading from a release before migration `0043`.
Fresh installs have nothing to convert.

## 1. What changes

| Migration                       | Kind                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0043_server_reads`             | schema and data, additive | Adds `test_runs.pending_steps` and `test_runs.failed_steps` (`integer NOT NULL DEFAULT 0`: a metadata-only change, no table rewrite). Builds the read indexes listed below. Drops the three single-column indexes they supersede (`test_runs_build_id_idx`, `screenshots_test_variation_id_idx`, `baselines_test_variation_id_idx`), after their replacements are built. Then **backfills** the counters in one `UPDATE`. |
| `0044_key_indexes_with_project` | indexes, additive         | Rebuilds the five storage-key indexes `0043` just built, under the same names, as `(key, project_id)`, so a key that many projects share resolves straight to the caller's project. Adds `test_runs_image_name_idx` for the last key column the access check reads.                                                                                                                                                       |

The indexes, by table:

- `test_runs`: `test_runs_pending_idx` (runs with pending steps),
  `test_runs_build_created_idx` and `test_runs_build_status_idx` (a batch's
  runs, a page at a time), `test_runs_running_idx` (the diff-worker
  reconciler's scan of running runs), and the key indexes
  `test_runs_diff_name_idx` and `test_runs_image_name_idx`.
- `screenshots`: `screenshots_variation_created_idx` (a variation's newest
  captures) and the key indexes `screenshots_image_key_idx`,
  `screenshots_dom_key_idx`, `screenshots_element_map_key_idx` and
  `screenshots_diff_image_key_idx`.
- `baselines`: `baselines_variation_branch_created_idx` (one step's baseline).

**The counters.** `pending_steps` counts a run's steps that need review: verdict
`new` or `unresolved` and no active decision, and only while the run is
reviewable (not `running`, `aborted` or `empty`, no status override, every step
diffed). `failed_steps` counts those whose diff failed. One function writes
them, `recomputeRunStatus`, in the same transaction as the run's status and
under the run's lock. Every write path that changes a step's review state
calls it. The release before `0043` has no such code: it writes no counters.

## 2. Before you upgrade

1. **Snapshot the database.** See [`restore-from-backup.md`](./restore-from-backup.md).
2. **Set `P` and measure the tables** so you can read §3's figures for your
   install. `P` is the Compose command every step below uses:

   ```bash
   P="docker compose -p docker --env-file infra/docker/.env -f infra/docker/compose.yml"
   # For the one-file install instead:
   # P="docker compose -f furan-compose.yml"
   $P exec postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c \
     "SELECT (SELECT count(*) FROM screenshots) AS steps, (SELECT count(*) FROM test_runs) AS runs;"
   ```

3. **Stop the app services (api, capture-worker, diff-worker) while the
   migrations run (required).** The previous release can keep serving while
   `migrate` runs: on a second host, when `migrate` is run by hand with the
   app up, or under another orchestrator. Here that is unsafe, for four
   reasons, which is why the services are stopped first:
   - **Index builds block writes.** Each `CREATE INDEX` in `0043` and `0044`
     holds a SHARE lock on its table while it builds: every upload, diff and
     decision that writes `test_runs`, `screenshots` or `baselines` waits for
     it.
   - **`DROP INDEX` queues all traffic.** `0043` drops the three superseded
     indexes, and `0044` drops each key index before rebuilding it. A
     non-concurrent `DROP INDEX` must wait for every transaction already open
     on its table before it can take its ACCESS EXCLUSIVE lock. While it
     waits, every new read and write of that table queues behind it, and
     nothing sets a `lock_timeout`. So one long query on `screenshots` or
     `test_runs` (an api request, or the diff-worker's orphan reconcile,
     which reads all of `screenshots`) stalls all traffic to that table for
     as long as the query lasts. Between a key index's drop and the end of
     its rebuild, the storage proxy also checks that key with a table scan.
   - **The backfill can deadlock.** It row-locks the runs it writes. A write
     that locks several runs at once (approving a whole batch) can deadlock
     with it; Postgres then aborts one of the two. If it aborts the
     migration, `migrate` fails, and re-running it applies `0043` again from
     the start, rebuilding every index.
   - **The old release writes no counters.** A run it changes after the
     backfill has read it keeps a wrong count until its next write, and
     shows in the wrong place in the review queue until then (§5).

   Stop them first, and start the new images only after `migrate` has
   finished. Before running the commands below, update the checkout and the
   image tags in `compose.yml` (for the one-file install, set `FURAN_VERSION`
   or download the new `furan-compose.yml`), as in
   [`production-deploy.md` §0](./production-deploy.md#0-the-one-rule-that-bites-everyone-image--migration-lockstep).

   ```bash
   $P stop api capture-worker diff-worker integrations
   $P pull
   $P run --rm migrate
   $P up -d
   ```

   Then verify (§4) and take the steps of §5, which every upgrade takes.
   Stopping `integrations` too is optional: it writes none of the tables
   these migrations change. Let in-flight capture and diff jobs finish before
   stopping if you can (the queue checks are in
   [`migration-deploy-order.md` §2](./migration-deploy-order.md#2-procedure--single-host-compose-default-install),
   step 3).

   From a source checkout, stop `pnpm dev` (api, workers) and run
   `pnpm --filter @furan/db exec drizzle-kit migrate`. It applies every
   pending file in **one** transaction, so `test_runs` stays locked for reads
   and writes until the whole upgrade commits. That makes the counters exact,
   but only with nothing else connected.

## 3. How long it takes, and the disk it needs

Measured on a database of 1.09 million steps in 230,000 runs, where the image
and diff keys repeat about 24 times each (the same page captured again). The
figures for a different install are estimates and are marked as such.

| Work                                                         | Figure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0044`'s four `screenshots` key indexes                      | **Measured:** built in 1.4 s, 0.2 s, 0.8 s and 0.6 s (`image_key`, `dom_key`, `element_map_key`, `diff_image_key`); **18.1 MB** together (8.2, 0.9, 5.3 and 3.7 MB).                                                                                                                                                                                                                                                                                                                                                                          |
| `0044`'s two `test_runs` key indexes                         | **Measured:** 0.04 s and 0.1 s; `test_runs_diff_name_idx` 816 kB, `test_runs_image_name_idx` 8 kB (nothing writes `image_name` any more, so it holds only old rows).                                                                                                                                                                                                                                                                                                                                                                          |
| The same key indexes when every capture is a different image | **Estimate:** about **120 MB** at 1.2 million steps for the keys alone (the spec's figure, not measured). The `(key, project_id)` form adds about 16 bytes an entry (the project's uuid) where keys are distinct, so about 16 MB more per million such entries. Repeated keys are stored once per index page (btree deduplication), so shared images keep them far smaller, as measured above.                                                                                                                                                |
| Key indexes built twice                                      | `0043` builds the five key indexes on the key alone, then `0044` drops them and builds them again as `(key, project_id)`. On an upgrade across both files, count the key-index build time **twice**. Under the compose runner the disk is not needed twice: each statement commits on its own, so an index's file is gone before its replacement is built. Under `drizzle-kit migrate` (one transaction) a dropped index's file is removed only at commit, so both versions of each key index occupy disk until then: count their size twice. |
| `0043`'s other indexes                                       | **Estimate** (not measured; about 50 to 70 bytes an entry): `screenshots_variation_created_idx` about 70 MB at 1.2 million steps; `test_runs_build_created_idx` and `test_runs_build_status_idx` about 10 to 20 MB each at 230,000 runs. `test_runs_pending_idx` and `test_runs_running_idx` hold only runs with pending steps or in flight: small. The three dropped indexes give their space back.                                                                                                                                          |
| `0043`'s backfill                                            | **Estimate** (not measured): it reads every run once and the open steps once, and writes only the runs that have pending steps, usually a small share. Its time has not been measured, nor compared with the index builds': time it on the restored copy (below).                                                                                                                                                                                                                                                                             |

Each index build reads its whole table once and sorts it, so time grows a
little faster than the table. On a large install, run the migrations once on a
restored copy of the snapshot first and time them.

## 4. Verify

**The counters.** Run the rollup verifier. It checks every run's stored
counters against what its steps give, and every finished run's status:

```bash
$P run --rm --no-deps api apps/api/dist/cli/verify-review-rollup.js
```

From a source checkout, with `DATABASE_URL` set (the owner connection):
`pnpm --filter @furan/api exec tsx src/cli/verify-review-rollup.ts`.

Healthy output is `0 mismatches`, exit code `0`. Each mismatch is a line
`run_id, stored, computed, stored_counters, computed_counters`, the counters as
`pending/failed`; a counter mismatch is what §5's repair fixes. The CLI is
described in full in
[`review-model-upgrade.md` §4](./review-model-upgrade.md#4-verify-verify-review-rollup);
never point it at the api's `DATABASE_URL_APP` role.

**The pool wait.** The api now exports `furan_db_pool_wait_seconds`: how long
each tRPC call waited for its database transaction (a pooled connection, then
its `BEGIN`). Read it from `/metrics` on the api:

```bash
# compose.yml (the api's port 3000 is published):
curl -s http://localhost:3000/metrics | grep '^furan_db_pool_wait_seconds'
# One-file install (the api's /metrics is not on the public port):
docker run --rm --network container:$($P ps -q api | head -n1) \
  curlimages/curl -s http://127.0.0.1:3000/metrics | grep '^furan_db_pool_wait_seconds'
```

The series is there as soon as the api starts. Once the dashboard has been
used, `_count` grows and most observations fall in the lowest buckets (a few
milliseconds). In Prometheus, the p95 over five minutes is
`histogram_quantile(0.95, sum by (le) (rate(furan_db_pool_wait_seconds_bucket[5m])))`.
If a large share of calls waits more than 100 ms, the api's connections are
all busy. The histogram leaves out a transaction that never begins (a connect
error, for one): those calls show as `server_error` in
`furan_trpc_procedure_duration_seconds` instead.

**The indexes**, optionally, with their sizes (12 rows, one per index of §1):

```bash
$P exec postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c \
  "SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) FROM pg_stat_user_indexes
   WHERE indexrelname = ANY (ARRAY['test_runs_pending_idx', 'test_runs_build_created_idx',
     'test_runs_build_status_idx', 'test_runs_running_idx', 'test_runs_diff_name_idx',
     'test_runs_image_name_idx', 'screenshots_variation_created_idx',
     'screenshots_image_key_idx', 'screenshots_dom_key_idx', 'screenshots_element_map_key_idx',
     'screenshots_diff_image_key_idx', 'baselines_variation_branch_created_idx'])
   ORDER BY 1;"
```

## 5. After the upgrade (every time)

1. **Repair the counters**, on every upgrade, whether or not you think
   anything wrote during the migrations:

   ```bash
   $P run --rm --no-deps api apps/api/dist/cli/verify-review-rollup.js --repair-counters
   ```

   From a source checkout, with `DATABASE_URL` set:

   ```bash
   pnpm --filter @furan/api exec tsx src/cli/verify-review-rollup.ts --repair-counters
   ```

   The counters are exact when nothing wrote during the migrations, but you
   cannot always know that: a writer of the previous release may have run
   **during or after** them (a service not stopped, a node that kept an old
   image, a rollback for a while before upgrading again), and a run it changed
   keeps a wrong count, so its steps are missing from the badge, the "Needs
   review" filter and the review queue. Running the repair anyway costs
   little and is safe:
   - it is **idempotent**: a run whose counters are right is not written, so
     a second run finds nothing to do;
   - it **locks one run at a time**, each in its own short transaction, and
     reads that run's steps under the lock, so it never overwrites a writer
     and is **safe while the app is up**;
   - it is **cheap**: it reads every run once, in pages, and writes only the
     runs whose counters are wrong.

   It never changes a status: a run whose status is wrong too is listed as
   not repaired and settled through
   [`review-model-upgrade.md` §5](./review-model-upgrade.md#5-if-the-cli-reports-mismatches).
   It then checks again (`… mismatches after repair`); the exit code is that
   result.

2. **Reload open dashboard tabs.** A tab left open across the upgrade runs
   the previous bundle, and its diff viewer fails until reloaded.

Do not re-run `0043`'s backfill statement while the app is up: it computes
from one snapshot and can overwrite counters a writer has just set.

## 6. Rollback

Both migrations are additive, and the previous release works against the
schema they leave:

- it never reads or writes `pending_steps` or `failed_steps`; the rows it
  inserts get the default `0`;
- every lookup the three dropped indexes served is served by the new index
  that leads with the same column, and the key lookups by key alone use the
  leading column of the `(key, project_id)` indexes;
- the new indexes cost it only their upkeep on each write.

So rolling back is the image tags alone: stop the services, put the previous
tags back, and `up -d`. No schema change is needed. While the previous release
runs, it leaves the counters of every run it changes wrong. When you upgrade
again, the migrations are already applied and do not run again; §5's repair,
which every upgrade runs, fixes those counters.

To return to the schema from before the upgrade, restore the snapshot from
§2 ([`migration-deploy-order.md` §4](./migration-deploy-order.md#4-rollback)).
That drops everything written since it was taken.

## 7. References

- Migrations: [`packages/db/migrations/0043_server_reads.sql`](../../packages/db/migrations/0043_server_reads.sql) and [`0044_key_indexes_with_project.sql`](../../packages/db/migrations/0044_key_indexes_with_project.sql): each header documents its locks under both runners
- The counters' definition: [`packages/db/src/run-counters.ts`](../../packages/db/src/run-counters.ts)
- Spec: `furan-design/specs/2026-10-27-speed-at-scale-server-reads-design.md` (gitignored design dir)
- Related runbooks: [`review-model-upgrade.md`](review-model-upgrade.md) (the `verify-review-rollup` CLI), [`migration-deploy-order.md`](migration-deploy-order.md), [`restore-from-backup.md`](restore-from-backup.md)
