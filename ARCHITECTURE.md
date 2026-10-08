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
| `apps/diff-worker`    | BullMQ consumer                                   | Resolves the baseline, runs the comparison, stores regions and status, applies auto-rules, runs retention sweeps                                               |
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
3. When the SDK completes the run, the api enqueues a **diff job** on Redis.
4. The **diff-worker** finds the baseline for each checkpoint's **variation**
   — the test name plus its environment (browser, viewport, OS, device) — on
   the run's branch, falling back to the pull request's base branch and then
   the project's default branch.
5. It compares the images and writes the result: the diff overlay, changed
   regions, a status (`passed`, `unresolved`, `failed`, or `new` when no
   baseline exists yet), and an optional Visual-AI explanation.
6. Updates are published over Redis and streamed to open dashboards as
   server-sent events; the GitHub App updates the commit status.
7. A reviewer approves (the candidate becomes the new baseline) or rejects.
   The first baseline for a new variation is approved by a person by default.

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
