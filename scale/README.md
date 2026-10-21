# @furan/scale: the scale harness

The harness answers one question: does Furan stay fast when a project is big?
It seeds a large project into a scratch database, starts the **real API and the
real diff worker in this process**, drives them the way production does, and
checks the results against the **budgets** in [`src/budgets.ts`](src/budgets.ts).
It writes a report and exits non-zero when a budget that is enforced fails.

It measures; it does not fix. A budget that fails today is reported with the
slice that owns the fix (see [Budgets and enforcement](#budgets-and-enforcement)).

It replaces the old `apps/api/scripts/perf-review-loop.ts` script. That script's
shape, its worst-case project and its method live on in the server suite as the
`R1-solo` and `R2-solo` budgets (one caller, no HTTP, p95 over 50 calls after
5 warm-ups).

## Quick start

You need a Postgres server, a Redis and (for the default `--storage=s3`) an S3
endpoint such as MinIO. The dev compose data plane works:

```bash
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml \
  --profile s3 up -d postgres redis minio minio-init

export SCALE_DATABASE_URL='postgresql://<user>:<password>@localhost:5433/postgres'
export SCALE_REDIS_URL='redis://localhost:6379'
export SCALE_S3_ENDPOINT='http://localhost:9000'
export SCALE_S3_ACCESS_KEY='<s3 access key>'
export SCALE_S3_SECRET_KEY='<s3 secret key>'

pnpm --filter @furan/scale scale -- --shape=smoke   # about 3 minutes
pnpm --filter @furan/scale scale                    # the large shape
```

The `scale` script first builds the harness's workspace dependencies
(`turbo run build --filter=@furan/scale^...`), then starts the CLI. The report is
written to `scale/out/` (gitignored). An unknown flag prints the usage and exits 2.

It is safe next to your own dev stack: it touches only the database, Redis keys,
bucket and ports listed under [What it touches](#what-it-touches).

## Settings

The harness reads **only `SCALE_*` variables**. It never falls back to
`DATABASE_URL`, `REDIS_URL` or `S3_*`, so a shell set up for your dev stack
cannot point it at that stack by accident.

| Variable                                                          | Required       | Meaning                                                                                                                                                                           |
| ----------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCALE_DATABASE_URL`                                              | always         | Admin-capable URL of the Postgres server, naming an admin database such as `postgres`. The harness creates `furan_scale` on that server itself.                                   |
| `SCALE_DATABASE_URL_APP`                                          | no             | URL of a non-owner role on the same server. Its database is rewritten to `furan_scale` and given to the API as `DATABASE_URL_APP`, so requests run subject to row-level security. |
| `SCALE_REDIS_URL`                                                 | always         | Redis URL.                                                                                                                                                                        |
| `SCALE_S3_ENDPOINT`, `SCALE_S3_ACCESS_KEY`, `SCALE_S3_SECRET_KEY` | `--storage=s3` | S3 endpoint and credentials. The harness makes its own bucket and needs the right to create and delete it.                                                                        |
| `SCALE_S3_REGION`                                                 | no             | Region (default `us-east-1`).                                                                                                                                                     |

**Refusals.** The harness stops with a clear message, never printing a URL or a
password, when:

- a required variable is missing (exit 2), or a URL is not a valid `postgres:` /
  `redis:` URL;
- `SCALE_DATABASE_URL` names the database `furan_scale`: the harness creates,
  seeds and drops that database itself, so the URL must name an admin one;
- another harness run already uses the same Postgres server. One run per server:
  a session-level advisory lock, taken in the server's `postgres` database,
  guards `furan_scale`;
- the server is local (`localhost` or `127.0.0.1`) and `/` has less than 10 GiB
  free. The large seed needs about 3 to 5 GB.

The harness's own listeners (the API) use a free port chosen at start. They
never use 3000, 3001, 5433, 6380 or 9000, the ports a dev stack may be using.

## Flags

```
pnpm --filter @furan/scale scale -- [flags]
```

| Flag                              | Default     | Meaning                                                                |
| --------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `--suite=browser,server,pipeline` | all         | Suites to run. `--suite=` (empty) runs none.                           |
| `--shape=large\|smoke`            | `large`     | Seed shape (see [Shapes](#shapes)).                                    |
| `--storage=s3\|hdd`               | `s3`        | Object storage: a bucket on the S3 endpoint, or a temporary directory. |
| `--keep`                          | off         | Keep `furan_scale` and its bucket or directory afterwards.             |
| `--reuse`                         | off         | Keep a seed that is already current; needs an earlier `--keep` run.    |
| `--no-build`                      | off         | Reuse the dashboard build if it is still current (browser suite).      |
| `--report=<dir>`                  | `scale/out` | Where the report goes.                                                 |

The browser suite builds the dashboard for production into
`apps/dashboard/.next-scale`, apart from the `.next` a dev server uses.
`--no-build` reuses that build only when `apps/dashboard`, `packages/`,
`pnpm-lock.yaml` and the root `package.json` have no uncommitted changes and are
what the build was made from; otherwise it builds anyway.

Suites **always run in the same order: browser, then server, then pipeline**,
whatever order `--suite` names them in. Each suite changes the seeded project
(approvals, new batches), so the one that changes it least runs first.

**Keeping a seed.** Seeding the large shape takes a while, so a run can keep it:

- `--keep` leaves `furan_scale` and its bucket or directory in place (the
  database records where its storage is).
- A later run with `--reuse` re-attaches them and skips the seed **if** the seed
  is still current: the same shape and `SHAPE_VERSION`, and no earlier run has
  measured against it. The CLI marks the seed used right before the first suite
  starts, because every suite changes the project. So after any measured run the
  next `--reuse` reseeds. A run that ended before any suite left the seed usable.
- A later run that does not re-attach a kept location removes it at the end, so
  nothing is orphaned.

## What a run does

1. Takes the run lock, creates `furan_scale` if it is missing and migrates it.
2. Prepares the storage, clears the harness's Redis keys and seeds the shape
   (images first, then set-based SQL). The seed then runs the app's real
   `recomputeRunStatus` on a sample of runs and **stops with an error if any
   status would change**, so the seed cannot drift from the app's rules.
3. Starts the API and the diff worker in this process, and logs in once.
4. Runs the selected suites, each guarded: if one throws, its budgets are
   reported as `error` with the message and the others still run.
5. Writes the report, tears everything down and exits.

Both services run with fixed, comparable settings:

- **The API** runs with the schema's defaults. The harness sets only the
  database, Redis, the storage, a JWT secret generated per run and
  `LOG_LEVEL=warn`, and **clears every other variable the API's env schema
  reads**. Tuning variables from your shell (`NODE_ENV`, `TRUST_PROXY`,
  `JWT_EXPIRY`, and so on) are ignored, so a run measures the same
  configuration anywhere.
- **The diff worker** runs with concurrency 4 (the production default) and the
  **stale-run sweeper off**: the seed holds `running` runs with old timestamps,
  and the sweeper would finalise them and change the shape being measured.

**Interrupts.** Ctrl-C (or SIGTERM) stops the run and tears down everything that
was opened, newest first: the API and worker are closed, the Redis keys are
removed, and the scratch database and bucket (or directory) are removed unless
`--keep`. A second Ctrl-C exits at once, which can leave `furan_scale` or a
bucket behind.

**Exit status.** 0 passed. 1 failed: the budget outcome (see
[Reading the report](#reading-the-report)), a run that stopped early with an
error (seed drift, another run holding the lock, the disk refusal), or a cleanup
step that failed. 2 bad flags or settings. 130 or 143 after SIGINT or SIGTERM.

## Suites

| Suite      | Budgets  | What it does                                                                                                                                                                                                                                                                                                                    |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline` | P1 to P6 | Uploads steps through the real SDK upload route with a personal access token and measures the diff pipeline: diff work per run, upload-to-result time, run completion time, sustained throughput, an upload/ignore-region/undo race, and live-update events per run.                                                            |
| `server`   | R1 to R8 | The shape's reviewers (20 on `large`, 3 on `smoke`) loop through a review session over HTTP for a 60 s window after a 10 s warm-up. Each procedure is timed on its own call. Also the solo timings (single caller, no HTTP), the viewer's open call set, the storage-proxy access check, `review.approve`, and failed requests. |
| `browser`  | D1 to D5 | Chromium against a production build of the dashboard: batches page, a 1,000-run batch, approving a step, live updates during an upload, and the viewer.                                                                                                                                                                         |

The browser suite is added by the next change. Until then, selecting it reports
its budgets as `error` and the run exits 1, so use `--suite=server,pipeline`.

The budget table (ids, thresholds, owners, status) is in
[`src/budgets.ts`](src/budgets.ts); this file does not repeat thresholds.

## Shapes

|                          | `large`                                        | `smoke`                                         |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------- |
| Purpose                  | The real measurement                           | Checks that the harness works (about 3 minutes) |
| Reviewers (`editor`)     | 20                                             | 3                                               |
| Nightly batches          | 200, each 1,000 runs of 5 steps                | 5, each 10 runs of 3 steps                      |
| PR batches               | 9,800 over 40 branches, each 3 runs of 3 steps | 15 over 3 branches, each 2 runs of 2 steps      |
| Long run (crawler-style) | 500 steps, about 200 earlier captures          | 20 steps, 4 earlier captures                    |
| Pipeline sets            | `pipeline-50`, `-200`, `-500`                  | three sets of 10 steps                          |

Both shapes have one project with the reviewers and an admin, plus a second
**worst-case project** (every recent batch resolved) for the solo timings. The
newest nightly is the review batch: about 5% of its steps pending, 40% decided
and 55% passed, with 3% of runs `running` or `aborted`. Non-passed steps carry
2 to 5 diff regions. Old history shares a pool of 24 generated PNGs; the newest
batch and the long run get unique images. Passwords are generated per run and
never printed.

A **smoke run never judges thresholds**: a missed threshold does not change its
exit code. It still exits 1 when a budget in a suite that ran has no value or
errored, or when the seed check fails.

## What it touches

| Resource | What the harness uses                                                                                                                                                                                                                                                                          | Removed                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Postgres | The database `furan_scale` on the server, plus one session on the server's `postgres` database that holds the run lock                                                                                                                                                                         | At the end, unless `--keep` (the lock is always released)               |
| Redis    | `furan-scale:*` (diff queue prefix and rate-limit store), and the API's `auth:user:<id>` and `auth:member-projects:<id>` for the scratch users only. The API and worker also publish on the `project:<id>:events:raw` and `run:<id>:events` channels (scratch ids only; channels hold no keys) | At the end, with or without `--keep`; `furan-scale:*` also at the start |
| S3       | A bucket `furan-scale-<8 hex>`                                                                                                                                                                                                                                                                 | At the end, unless `--keep`                                             |
| Disk     | With `--storage=hdd`, a directory `furan-scale-*` in the OS temp dir; reports in `scale/out/`                                                                                                                                                                                                  | At the end, unless `--keep` (the report stays)                          |
| Ports    | The API on a free loopback port                                                                                                                                                                                                                                                                | At the end                                                              |

Nothing else on the server, in Redis or in the bucket store is read or deleted;
a recorded location is removed only if it has the harness's own name.

## Reading the report

`scale-report.md` (for people) and `scale-report.json` (the same data, to compare
two runs) go to the report directory. The header records the machine (CPU and
memory), the Node version, the commit, the shape and the suites. Each budget is a
row: id, the budget, the measured value, its unit, its status, the verdict and the
owning slice. A **Notes** section carries per-budget detail (for example the
cases behind a solo timing).

Verdicts:

- `pass`: the value is within the threshold.
- `fail`: the threshold is missed. A tracked budget prints as
  `fail (tracked, owner slice N)`: the slice that owns the fix.
- `missing`: the suite ran but produced no usable value.
- `error`: the measurement itself failed (the message is in the notes).
- `skipped`: the budget's suite did not run.

**Tracked vs enforced.** A `tracked` budget is reported and never fails the run.
An `enforced` budget fails a `large` run when it misses its threshold.

**A run's budget outcome exits 1 only when** an enforced budget fails on a
`large` run, or a budget in a suite that ran is `missing` or `error`, which holds
on `smoke` too. A tracked failure does not change it. The other ways to exit 1 or
2 (seed drift, a busy lock, the disk refusal, a failed cleanup, bad settings) are
listed under "Exit status" above.

## Budgets and enforcement

`src/budgets.ts` is the single source of truth for every id, threshold, owning
slice and status. Timings are p95 (nearest rank) over at least 50 samples after
5 warm-ups; counts are exact. The reference machine is GitHub's `ubuntu-latest`
runner, and local runs use the same thresholds.

**An owning slice enforces a budget with a one-line status change** in
`budgets.ts`, in that slice's PR:

```diff
-    status: "tracked",
+    status: "enforced",
```

An enforced budget never goes back to tracked.

**Never loosen a threshold quietly.** A threshold changes only with a ruling
recorded by the owning slice, with the reason in its PR. If a timing budget fails
one of three reruns at the same commit, the remedy is more samples, not a looser
threshold.

## CI

`.github/workflows/scale.yml` runs the harness on `ubuntu-latest`. It starts
**only by hand** (Actions, then `scale`, then Run workflow); it is not on pull
requests and not scheduled, to save Actions minutes.

Inputs:

- `shape`: `smoke` (default) or `large`;
- `suites`: comma-separated (default `pipeline,server,browser`);
- `storage`: `s3` (default) or `hdd`.

The job starts Postgres 17 and Redis 7 containers and MinIO, with Postgres and
MinIO passwords generated at run time (so there is nothing to commit and nothing
for secret scanning to flag). It installs Chromium, exports the `SCALE_*`
settings from the container ports, and runs
`pnpm --filter @furan/scale scale -- --shape=… --suite=… --storage=…`. The step
fails, and so the job, when the harness exits 1. The report is uploaded as the
`scale-report` artifact (`scale-report.md` and `scale-report.json`, kept 14 days)
whether or not the job passed. The job times out after 60 minutes, and only one
runs per ref at a time.

A hosted runner starts with little more than the 10 GiB the harness requires, so
the job's first step frees disk (it removes the unused .NET, Android, GHC and
CodeQL toolchains and the pre-pulled Docker images, then prints `df -h /`). It is
best-effort and gates nothing. The harness's own check is a guard, not a
measurement: it reads the free space of `/`. On a hosted runner that is the
filesystem holding Docker's data root (`/var/lib/docker`, where the Postgres
container's data lives) and the temp dir used by `--storage=hdd`, so it measures
the right disk there. Run elsewhere (for example Postgres on a separate volume),
`/` may not be where the data goes. If the check still fails in CI, it stops
early with a clear message.

## Development

```bash
pnpm --filter @furan/scale test
pnpm --filter @furan/scale typecheck
pnpm --filter @furan/scale lint
```

The unit tests need no services and join the normal `pnpm test`. The scratch,
seed and Redis-key tests run only when `SCALE_DATABASE_URL` or `SCALE_REDIS_URL`
is set, against the server it names (they create and drop `furan_scale`, so point
them at a test server). The harness itself runs only through the `scale` script,
never through `pnpm test`.
