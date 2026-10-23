# diff-queue-backlog runbook

Use when diffs are slow to land: runs stay `running`, builds sit without a
verdict, or the diff queue stops draining. The diff worker (`apps/diff-worker`)
consumes the Redis-backed `diff` queue. This page says which of its metrics to
read, what they mean, and what to do about each cause.

> The worker serves `/livez`, `/readyz` and `/metrics` on port 3200 (`PORT`).
> Neither compose file maps it to the host and the image is distroless, so
> probe from a sidecar that shares its network namespace. `head -n1` picks one
> replica, so the command still works once the worker is scaled (Action 4); to
> probe another one, take its line with `sed -n 2p` instead.
>
> ```bash
> DW=$(docker compose -f infra/docker/compose.yml ps -q diff-worker | head -n1)
> docker run --rm --network container:$DW curlimages/curl -s http://127.0.0.1:3200/metrics | grep '^furan_diff_'
> ```

## Symptoms

- Runs stay `running` longer than usual, and CI callers waiting for a verdict
  time out.
- `furan_diff_queue_jobs{state="waiting"}` climbs and does not fall back to 0
  between runs.
- The p95 of `furan_diff_job_queue_wait_seconds` keeps rising.
- The worker logs `diff_job_dead_lettered` or `diff_queue_depth_unavailable`.

**A backlog delays results, it never changes them.** Every 30 s each worker's
reconciler looks at the steps that have waited more than 10 minutes for a diff
result:

- A step whose job is still in the queue (`waiting`, `active`, `delayed`) is
  left alone, however deep the backlog.
- A step whose job was lost (gone from Redis, or finished without writing a
  result) is re-queued. It logs `reconciler_step_requeued` and counts in the
  worker's `furan_diff_jobs_enqueued_total{trigger="reconcile"}`.
- After 3 re-queues of the same step, the step fails with the reason
  `timeout` (`reconciler_step_timed_out`): its verdict becomes `unresolved`, so
  its run needs attention.

A step without a result is never marked passed by time. Earlier releases had a
stale-run sweeper that turned such steps into `passed` after 5 minutes, a CI
false pass under a backlog; it is gone. A `running` run that no step was
uploaded to still becomes `empty` after 5 minutes.

## The four metrics

| Metric                              | What it measures                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `furan_diff_queue_jobs{state}`      | Jobs in the queue by state, read from Redis on each scrape (see below).              |
| `furan_diff_job_queue_wait_seconds` | Enqueue to first pick-up, first attempts only. The delay a backlog costs a user.     |
| `furan_diff_job_duration_seconds`   | One attempt, start to finish, labelled `outcome` = `completed`, `retry` or `failed`. |
| `furan_diff_job_checkpoints`        | Checkpoints (screenshots) one completed job diffed.                                  |

**`furan_diff_queue_jobs` is queue-wide, the other three are per replica.**
Every replica reads the same Redis queue, so with N replicas each `/metrics`
reports the same `waiting`, `active`, `delayed` and `failed`. Aggregate it with
`max by (state) (furan_diff_queue_jobs)`: a `sum` counts every job N times. The
histograms and `furan_diff_jobs_dead_lettered_total` are counted by the replica
that ran the job, so those do need a `sum` (for a quantile,
`histogram_quantile(0.95, sum by (le) (rate(<metric>_bucket[5m])))`).

The `state` label of `furan_diff_queue_jobs`:

- `waiting`: queued, not picked up yet. This is the backlog.
- `active`: being diffed now, across all replicas. Each replica runs at most 4
  at a time.
- `delayed`: an attempt failed and the job is waiting out its retry backoff.
- `failed`: jobs that used all 3 attempts and that Redis still holds (24 h, at
  most 5000). It is a level that ages out, not a running total. Use
  `sum(rate(furan_diff_jobs_dead_lettered_total[5m]))` for the rate.

If the gauge has no series, or stops changing, the worker cannot read Redis in
500 ms: it keeps the last values and logs `diff_queue_depth_unavailable` (at
most once a minute). Before its first successful read it reports nothing
rather than 0.

## Reading them together

- `waiting` rising, `active` at its cap (4 per replica, so 4 times the number
  of replicas in the queue-wide gauge), duration flat: not enough workers for
  the arrival rate. Scale (below).
- `waiting` rising and `active` at 0: nothing is consuming. A stuck or dead
  worker, or Redis. Check `/readyz` first.
- Duration p95 rising while queue wait is flat so far: jobs are getting
  slower. See the slow VLM provider and big run causes.
- `delayed` or `failed` rising: attempts are failing. Read the logs.
- **Checkpoints per job well above 1 means whole-run re-diffs.** A job names a
  run, not a checkpoint, and each upload enqueues one, so a run of N
  checkpoints enqueues N jobs and each diffs all of the run's checkpoints,
  not only the one that triggered it. This is fixed in a later release; until
  then it multiplies the cost of big runs.

## Causes

- **A slow VLM provider.** The VLM layer runs only when the pixel diff finds a
  change. Each call is capped at 60 s and falls back to the pixel verdict on
  failure, so a degraded provider stretches every such job by up to a minute.
  Look for duration p95 near 60 s and a rising `furan_diff_vlm_failures_total`.
  Check the provider's status and quota, or the load on a self-hosted model.
- **A big run.** A few jobs with a high checkpoint count dominate duration
  and hold the queue behind them. They drain by themselves; scale to drain
  them faster.
- **A stuck worker.** `/readyz` returns 503, or `active` stays above 0 with no
  new `diff_job_received` log lines. BullMQ hands the jobs of a worker that
  stopped renewing its locks back to `waiting` once the lock expires (30 s by
  default).

## Actions

1. **Check `/readyz`** with the sidecar above (use
   `-s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3200/readyz`). 503
   means a worker is not running, or Redis or Postgres failed a 1 s probe, and
   `readyz_dependency_probe_failed` in the logs names the error. For a
   dependency, follow **Readyz failing** in [api-down.md](./api-down.md).
2. **Read the worker logs:**

   ```bash
   docker compose -f infra/docker/compose.yml logs diff-worker --tail=200
   ```

   `diff_job_failed_will_retry` is a failing attempt that will retry. A job
   that exhausted its attempts logs `diff_job_dead_lettered`, and its step
   fails with a reason code (`unresolved`). If even that write failed, the
   reconciler re-queues the step once it has waited 10 minutes.

3. **Look at the dead letters.** The newest failed jobs and why:

   ```bash
   docker compose -f infra/docker/compose.yml exec redis redis-cli ZREVRANGE bull:diff:failed 0 4
   docker compose -f infra/docker/compose.yml exec redis redis-cli HGET bull:diff:<job-id> failedReason
   ```

   One reason repeated across jobs (a provider error, a missing screenshot)
   points at a shared cause. The same commands on `bull:diff:wait` and
   `bull:diff:active` (`LLEN` or `LRANGE`) show the queue itself.

4. **Scale the diff worker.** A worker runs 4 jobs at once and there is no
   setting for that, so add replicas and give each enough CPU and memory
   (pixel diffs are CPU and memory bound on large screenshots):

   ```bash
   docker compose -f infra/docker/compose.yml up -d --scale diff-worker=3
   ```

   Replicas share the queue. Each one also runs the reconciler, which is safe
   to run concurrently: a replica claims a re-queue before it adds the job, so
   two replicas never re-queue one step twice. If the cause is a slow VLM
   provider, more replicas add waiting calls, not speed: fix the provider
   instead.

5. **Restart a stuck worker.**

   ```bash
   docker compose -f infra/docker/compose.yml restart diff-worker
   ```

   On SIGTERM the worker stops taking jobs and waits for its in-flight ones,
   but only for the container's stop grace period: 10 s by default, and the
   `diff-worker` service sets none. A longer job is then killed mid-run. It is
   not lost: once its 30 s lock has expired, BullMQ's next stalled-job check
   (every 30 s) puts it back in the queue and a worker runs it again from the
   start (a job that stalls a second time is failed instead). To let long jobs
   finish, raise `stop_grace_period` on the `diff-worker` service.

## Escalate

| Condition                                                           | Escalate at |
| ------------------------------------------------------------------- | ----------- |
| `waiting` still growing after scaling and a restart                 | 15 min      |
| The reconciler keeps re-queuing steps, or fails them with `timeout` | 15 min      |
| `failed` or dead-letters rising with one repeated `failedReason`    | 15 min      |
| Redis out of memory, or `/readyz` 503 on Postgres or Redis          | 10 min      |

Open an issue with a `/metrics` snapshot of the `furan_diff_` series, the last
200 worker log lines, and the `failedReason` of a few failed jobs.

## See also

- [api-down.md](./api-down.md): Redis and Postgres health, rollback
- [production-deploy.md](./production-deploy.md): compose bring-up and env vars
