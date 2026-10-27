# Architecture

Furan is a self-hosted visual regression testing service. Tests capture
screenshots through an SDK, Furan compares each one against an approved
baseline, and reviewers approve or reject the differences in a web dashboard.

## Services

```
  test runner ──SDK──▶  api  ◀──tRPC/REST──  dashboard  ◀── reviewers
  (JUnit + Selenium /    │  ▲                 (Next.js)
   Playwright / Appium)  │  └──── SSE (live run / project events)
                         │
            ┌────────────┼──────────────┬──────────────────┐
            ▼            ▼              ▼                  ▼
        Postgres       Redis       object storage     integrations
       (all state)  (queues, pub/  (S3 / MinIO, or    (GitHub App,
                     sub, caches)   local disk)        Slack)
                         │
                ┌────────┴────────┐
                ▼                 ▼
          diff-worker       capture-worker
```

| Service               | Stack                                             | Responsibility                                                                                                                                                 |
| --------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`            | Fastify 5, tRPC v11, Drizzle                      | REST API for SDKs and CI, tRPC for the dashboard, auth, RBAC, server-sent events, OpenAPI at `/openapi.json`                                                   |
| `apps/dashboard`      | Next.js 15, React 19, Tailwind v4, Radix, pixi.js | Review UI: builds, the diff viewer, approvals, project settings, admin                                                                                         |
| `apps/diff-worker`    | BullMQ consumer                                   | Diffs one step per job: resolves the baseline, runs the comparison, stores regions and status, applies auto-rules; re-queues lost jobs; runs retention sweeps  |
| `apps/capture-worker` | Playwright (Chromium), sharp                      | Server-side page capture job consumer. Today screenshots are captured by the SDKs inside the test run; server-side capture is not yet exposed through the API. |
| `apps/integrations`   | Fastify, Octokit                                  | GitHub App (commit status + sticky PR comment) and Slack notifications                                                                                         |

Shared packages live in `packages/`: `db` (Drizzle schema, migrations, query
helpers — the only package allowed to import `drizzle-orm`), `config` (Zod env
validation), `queue` (BullMQ), `storage` (S3 + filesystem backends behind one
interface), `telemetry` (logging, tracing, metrics), `diff-engine`,
`rules-engine`, `shared-types`, and `sdk-kotlin` (the JVM SDK).

## How a run flows

1. The SDK opens a **build** (one CI run) and a **test run**, then uploads each
   **checkpoint** screenshot. It can also send the page's DOM and an element
   map (CSS selector → bounding box) so regions can be tied to elements.
2. Images go to object storage, content-addressed by hash; metadata goes to
   Postgres.
3. Each upload queues a **diff job** on Redis for its own checkpoint (a
   **step**), so a run of N steps is diffed N times, once per step. A job
   names the step and the step's **version** (its id is
   `<step id>-g<version>`). The version is bumped each time the step needs a
   new diff: its upload, an ignore-region or threshold edit, an undo, a branch
   merge or a retry, each of which queues only the steps it affects. The run
   stays `running` until every step has a result.
4. The **diff-worker** runs one job per step. It finds the baseline for the
   step's **variation** — the test name plus its environment (browser,
   viewport, OS, device) — on the run's branch, falling back to the pull
   request's base branch and then the project's default branch.
5. It compares the images, then commits the step's result: the diff overlay,
   changed regions, the step's verdict (`passed`, `unresolved`, or `new` when
   no baseline exists yet), its diff % and an optional Visual-AI explanation.
   The commit locks the run, then the step, and **re-checks the version**: a
   job whose step has been given a newer version in the meantime is stale and
   writes nothing, so overlapping jobs never duplicate or lose a step's
   regions. In the same transaction the run's totals (diff %, changed pixels,
   baseline source) and its status are recomputed from its steps.
   - **A failed diff fails only its step.** When a step's job fails its last
     attempt, the step is marked `unresolved` with a reason code (such as
     `image_unreadable`) and shows "Diff failed" in the dashboard, where an
     editor can retry it. The run is never aborted; it needs attention, so CI
     reports a failure, never a pass.
   - **A reconciler** in each diff-worker looks every 30 s for steps that
     have waited more than 10 minutes for a result. A step whose job is gone
     is queued again at the same version, under the same job id (a step
     uploaded before per-step diffs gets its first version); after 3 such
     re-queues it fails with `timeout`. A step is never marked passed
     for waiting too long. See
     [`docs/runbooks/diff-queue-backlog.md`](docs/runbooks/diff-queue-backlog.md).
6. Updates are published over Redis. After every step the worker publishes
   `run.checkpoint_diffed`; only when that step changed the run's status does
   it also publish `run.completed`, with the run's totals, and the project's
   `testRun_updated` and `build_updated`. Open dashboards receive them as
   server-sent events. The integrations service acts on `run.completed`:
   Slack posts once the status is final, and outbound webhooks subscribed to
   `run.completed` receive it. The GitHub App's commit status and PR comment
   need the event to carry the repository fields (installation, owner,
   repository, commit and pull request); the diff-worker's `run.completed`
   does not carry them today, so the GitHub App skips it.
7. A reviewer approves (the candidate becomes the new baseline) or rejects.
   The first baseline for a new variation is approved by a person by default.

**Outbound webhooks get one `run.completed` per status change.** A generic
(non-Slack) webhook receives a delivery each time a run's status changes,
usually once, when the run leaves `running`. Releases before the per-step
pipeline sent one per diff job, most of them repeating `running`. The
payload's `diffPercent` is omitted when no step of the run was compared with a
baseline (every step `new`).

**Reads stay small as a project grows.** Each run stores how many of its
steps need review (`pending_steps`, and `failed_steps` for those whose diff
failed). One function writes them, `recomputeRunStatus`, in the same
transaction as the run's status and under the run lock every write path takes
first; `verify-review-rollup --repair-counters` checks and repairs them (see
[`docs/runbooks/server-reads-upgrade.md`](docs/runbooks/server-reads-upgrade.md)).
The review queue, the pending counts and the "Needs review" filters read those
counters, and the batch and run lists pick one page of rows first and build
only that page. The diff viewer reads the run's header and step list, then one
step at a time (`runs.getStep`: its baseline, regions and review), fetching
the steps either side of it ahead. The storage proxy checks that an image
belongs to one of the caller's projects through indexes that lead with the
storage key and carry the project.

## Comparison pipeline

The **image is the source of truth**:

- **Pixel comparison** — odiff (default), pixelmatch, or looks-same per
  project, with ignore/strict regions, a configurable threshold, and optional
  shift detection. Produces the diff image and the changed regions.
- **Visual AI (optional)** — when the pixel step finds a difference, a vision
  model (local Ollama, Gemini, or Anthropic) can describe it in plain language
  and mark cosmetic noise as identical. If the model is unavailable, the pixel
  verdict stands.
- **Accessibility (optional)** — axe-core checks on the captured DOM, reported
  as regions.
- **Auto-rules** — project rules that automatically resolve known, expected
  differences, with every application recorded.

## Security model

- **Authentication:** the dashboard uses JWTs; SDKs and CI use personal access
  tokens (`furan_pat_…`, stored hashed). Both are sent as `Authorization:
Bearer`. The user's current role and active status are re-checked on each
  request (through a short-lived cache), so a demotion or deactivation takes
  effect immediately rather than when a token expires.
- **Roles:** `owner` ⊇ `admin` ⊇ `editor` ⊇ `guest`. Editors work only in
  projects they're members of; admins manage users and projects.
- **Tenant isolation:** every query filters by project, enforced by a
  membership check on each route, with optional Postgres row-level security as
  a backstop.
- **Audit log:** user, membership, review, and rule changes are recorded.

## Operations

- **Install:** Docker Compose — `infra/docker/compose.yml` for a full
  install, or the one-file `infra/docker/furan-compose.yml` (single origin
  behind nginx on `:8080`). Images are multi-arch, cosign-signed, scanned, and
  published with an SBOM.
- **Storage:** bundled MinIO (S3) by default, any S3-compatible bucket, or the
  local filesystem — see [`docs/runbooks/storage-backends.md`](docs/runbooks/storage-backends.md).
- **Observability:** structured JSON logs correlated with OpenTelemetry
  traces, Prometheus metrics, and `/livez` + `/readyz` probes on the api and
  workers.
- **Schema changes** are additive-first migrations applied by a one-shot
  `migrate` container — see
  [`docs/runbooks/migration-deploy-order.md`](docs/runbooks/migration-deploy-order.md).

## Where to go next

- [README](README.md) — install, first snapshot, CI wiring
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, tests, conventions
- [`docs/runbooks/`](docs/runbooks/) — operating Furan in production
