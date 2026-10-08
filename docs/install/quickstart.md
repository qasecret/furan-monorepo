# Furan — install quickstart (v1.1)

> **Just want to try it?** Fastest path — one file, no clone, no `.env`:
>
> ```bash
> curl -O https://raw.githubusercontent.com/qasecret/furan-monorepo/main/infra/docker/furan-compose.yml
> docker compose -f furan-compose.yml up -d
> # open http://localhost:8080 → admin@furan.local / FuranAdmin123!
> ```
>
> Ships **evaluation-default credentials + JWT secret** — override
> `FURAN_BOOTSTRAP_ADMIN_PASSWORD` / `JWT_SECRET` / `POSTGRES_PASSWORD` /
> `MINIO_ROOT_PASSWORD` (or set `FURAN_BIND=127.0.0.1`) before any networked use.
> The `pnpm dev` flow below is the **development** path for iterating on source.

> **Deploying for real?** Use the Docker-Compose production path in
> **[`docs/runbooks/production-deploy.md`](../runbooks/production-deploy.md)** —
> `docker compose -f infra/docker/compose.yml up -d` boots the **full** stack
> (data plane + all five app services) from pre-built images, auto-runs
> migrations, and auto-seeds the first admin. **This page** is the
> **development** path: a Dockerised data plane plus the Node 22 app services
> run from source via `pnpm dev`, for iterating on the code.

## What is Furan?

Furan is an Apache-2.0, self-hostable UI testing platform aimed at
small teams. Your CI (via the Kotlin SDK or the REST API) captures screenshots
of your app under test and uploads them to a Furan server, which compares them
against an approved baseline and surfaces a pixel-accurate diff in the dashboard
for human review and approval.

This guide runs the app services from source via `pnpm dev` against a Dockerised
data plane (Postgres + Redis + MinIO). For the image-based production install,
see the runbook linked above.

## Prerequisites

| Tool    | Version             | Why                                            |
| ------- | ------------------- | ---------------------------------------------- |
| Docker  | 24+ with Compose v2 | Postgres / Redis / MinIO data plane            |
| Node.js | 22 LTS              | api / dashboard / capture-worker / diff-worker |
| pnpm    | 9.15+               | Workspace package manager                      |
| openssl | any recent          | Generating `JWT_SECRET`                        |

Hardware budget: **~4 GB RAM**, **~10 GB disk** for a single-tenant host
(add ~6 GB disk for the production app images — the capture-worker alone is ~4 GB).

Supported platforms: **Linux x86_64**, **macOS arm64**, **macOS x86_64**.

## 1. Clone the monorepo

```bash
git clone https://github.com/<your-org>/furan-monorepo.git
cd furan-monorepo
```

## 2. Configure environment

Copy the example file and edit secrets in place:

```bash
cp .env.example .env
```

Generate strong secrets:

```bash
# JWT_SECRET (must be ≥32 chars — the api fails closed if shorter)
openssl rand -hex 32

# Postgres + MinIO passwords (any high-entropy value)
node -e "console.log(require('crypto').randomBytes(24).toString('base64'))"
```

Paste each value into the matching key in `.env`. The shipping defaults
(`POSTGRES_USER=furan`, `POSTGRES_DB=furan_dev`, `MINIO_BUCKET=furan-dev`)
are safe for a single-tenant host; you only have to set the three passwords plus
`JWT_SECRET`.

If the api or dashboard will run on a different host than the data plane,
also update `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, and
`NEXT_PUBLIC_API_URL` accordingly.

## 3. Start the data plane

```bash
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml up -d
```

The `compose.dev.yml` overlay exposes the otherwise-internal ports to the
host so the app services (running on the host via `pnpm dev`) can reach
them:

- Postgres on `localhost:5433`
- Redis on `localhost:6379`
- MinIO S3 API on `localhost:9000`, web console on `localhost:9001`

Wait ~15 seconds for healthchecks, then verify:

```bash
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml ps
```

All five services (`postgres`, `redis`, `minio`, `minio-perms`, `minio-init`)
should report healthy / exited-0. `minio-perms` (volume ownership) and
`minio-init` (bucket creator) are one-shots and are expected to exit.

> **Production-shaped install:** `compose.yml` boots the **full** stack (data
> plane + the five app services) from pre-built images published to Docker Hub
> (`docker.io/qasecret/furan-*:v1.1.x`, GHCR mirror at `ghcr.io/qasecret/furan-*`;
> cosign-signed, SBOM-attached). The smoothest path is the one-command
> [`./deploy.sh`](../../deploy.sh) — it generates `.env`, enforces the lockstep
> rule, brings the stack up in order, health-waits, and runs the drift canary.
> Otherwise run `docker compose -f infra/docker/compose.yml up -d` (no
> `-f compose.dev.yml`) and skip the rest of this quickstart's `pnpm` sections.
> **Caveat 1 (lockstep):** deploy from a checkout at the matching release tag —
> the `migrate` service applies your local migrations, which must agree with the
> pinned image. See the [production-deploy runbook §0](../runbooks/production-deploy.md#0-the-one-rule-that-bites-everyone-image--migration-lockstep).
> **Caveat 2 (dashboard UI):** on a plain `localhost` deploy of a **published
> image ≤ v1.1.27** the dashboard renders but **UI login does not work** (the
> server-side code targets a baked `localhost:3000` it can't reach from inside the
> container). Fixed in **`v1.1.28`** via a runtime `API_INTERNAL_URL`, so a
> **v1.1.28+** deploy (or a from-source `./deploy.sh --mode from-head` build)
> logs in fine on `localhost`; for **remote** browsers, deploy behind a
> domain per [reverse-proxy-tls.md](../runbooks/reverse-proxy-tls.md). The
> API/SDK path (§11) is fully functional regardless. This `pnpm dev` flow below
> (the **development** path) logs in fine because everything runs on the host.

## 4. Install dependencies + apply migrations

**Production-shaped install (Docker-only):** skip this entire section —
the `migrate` one-shot service in `compose.yml` applies every SQL file in
`packages/db/migrations/` automatically on `docker compose up -d`, and
the app services wait for it via `depends_on: condition:
service_completed_successfully`. It is idempotent: subsequent `up` runs
just verify the `drizzle.__drizzle_migrations` journal and exit.

**Dev path (host-process `pnpm dev`):** run migrations from the host:

```bash
pnpm install
pnpm --filter @furan/db db:migrate
```

The `db:migrate` script runs `drizzle-kit migrate` against `DATABASE_URL`
and applies every SQL file in `packages/db/migrations/`. Use this when
you are iterating on schema changes; the in-image migrator covers the
release install.

## 5. Seed your first admin

```bash
pnpm --filter @furan/api cli:seed-admin -- \
  --email you@example.com \
  --password 'a-strong-passphrase' \
  --first-name Your --last-name Name
```

The CLI no-ops if a user with that email already exists, so it is safe to
re-run.

If you ever need to reset that password (or any other user's), use:

```bash
pnpm --filter @furan/api cli:reset-password -- --email you@example.com
```

## 6. Start the app services

You need **two** terminals for the minimum smoke path (login + dashboard)
and **four** for the full capture-and-diff loop:

```bash
# Terminal 1 — api on http://localhost:3000
pnpm --filter @furan/api dev

# Terminal 2 — dashboard on http://localhost:3001
pnpm --filter @furan/dashboard dev

# Terminal 3 — capture worker (only needed once you start enqueuing captures)
pnpm --filter @furan/capture-worker dev

# Terminal 4 — diff worker (only needed once captures land)
pnpm --filter @furan/diff-worker dev
```

`tmux`, `overmind`, or any process manager you already use is fine. The
workers consume from BullMQ queues backed by Redis; they can start cold
later without losing work.

## 7. Sign in

Open <http://localhost:3001/login> and sign in with the email + password
you seeded in step 5. You should land on `/projects`, which will be empty
on first install.

## 8. Bootstrap your first project

Admins create and manage projects in the dashboard under **Admin → Projects**,
and assign members + each user's default project under **Admin → Members**
(ADR-052 single-project tenancy — there is no end-user project switcher). The
equivalent REST call is below; mint a session token by logging in via the API,
then call `POST /projects` (admin-only):

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"a-strong-passphrase"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')

curl -X POST http://localhost:3000/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My App","mainBranchName":"main"}'
```

You'll get back the created project row with its `id` (UUID). Hold onto
that id — you'll use it as `<projectId>` below.

> The dashboard (Admin → Projects) is the recommended path; the REST call
> above is handy for scripting a first project on a fresh install.

## 9. Add an editor user + grant project access

In the dashboard:

1. Navigate to **/admin/members** → **Create user** → role: `editor`. Set
   a temporary password and share it with your teammate.
2. Navigate to **/admin/projects/&lt;projectId&gt;/members** → **Add
   member** → enter the editor's email.

Editors only see projects they are members of; admins see everything.

## 10. Mint a personal access token (PAT)

Switch to your editor (or stay as admin), then:

1. Navigate to **/account/tokens** → **Create** → label `CI - main`.
2. **Copy the raw token immediately** — it is shown once, in a one-shot
   dialog, and the database only stores the SHA-256 hash. There is no
   recovery flow; if you lose it, delete and mint a new one.

Use this PAT as a `Bearer` token from any non-interactive client (CI, the
SDK, curl scripts).

## 11. First capture + first diff

Ingestion is **SDK-upload over REST** (the client captures the PNG and uploads
the bytes). The Kotlin SDK (`io.github.qasecret:furan-selenium`) is the
first-class path; CI uploads can also drive the REST endpoints directly. The
sequence (all `Authorization: Bearer <PAT>` from step 10):

```bash
API=http://localhost:3000; PID=<projectId>     # from step 8
# 1. Build
BUILD=$(curl -s -X POST $API/projects/$PID/builds -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' -d '{"branchName":"main","name":"ci-1"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
# 2. Run
RUN=$(curl -s -X POST $API/runs -H "Authorization: Bearer $PAT" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PID\",\"buildId\":\"$BUILD\",\"name\":\"smoke\",\"branchName\":\"main\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).runId')
# 3. Upload a screenshot (base64 JSON variant; multipart pngBytes also supported)
curl -s -X POST $API/runs/$RUN/screenshots/base64 -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' \
  -d "{\"pngBase64\":\"$(base64 < shot.png | tr -d '\n')\",\"name\":\"homepage\",\"viewport\":\"1280x720\",\"browser\":\"chromium\"}"
# 4. Complete
curl -s -X POST $API/runs/$RUN/complete -H "Authorization: Bearer $PAT" \
  -H 'Content-Type: application/json' -d '{}'
```

The checkpoint identity is the tuple `(branchName, name, viewport, browser)` —
reuse the same values on later runs so they diff against the same baseline. The
`diff-worker` resolves the baseline and emits diff regions. On the **first** run
for a variation there is no baseline, so the run is stored as a baseline
**candidate** that a reviewer approves in the dashboard (ADR-036 — Furan does
not auto-seed the first baseline by default; `autoApproveFeature` is off for new
projects).

<details><summary>Dev-only alternative: enqueue a capture job directly</summary>

Bypassing the SDK/REST surface, you can push a job onto the capture queue from a
Node script in the monorepo (the `capture-worker` then navigates to a URL and
screenshots it server-side). Useful for worker-pipeline debugging. Create
`scripts/enqueue-capture.mjs`:

```javascript
import { createQueue } from "@furan/queue";
import { randomUUID } from "node:crypto";
import { createDb, builds, testRuns } from "@furan/db";

const projectId = process.env.PROJECT_ID; // from step 8
const url = process.env.TARGET_URL || "https://example.com";
if (!projectId) throw new Error("set PROJECT_ID env var");

const { db, close } = createDb();
const [build] = await db
  .insert(builds)
  .values({ projectId, isRunning: true, branchName: "main" })
  .returning();
const [run] = await db
  .insert(testRuns)
  .values({
    projectId,
    buildId: build.id,
    name: "smoke",
    branchName: "main",
    status: "running",
    testVariationId: randomUUID(),
  })
  .returning();

const q = createQueue("capture");
await q.add("capture", {
  runId: run.id,
  projectId,
  buildId: build.id,
  testVariationId: run.testVariationId,
  url,
  viewport: { width: 1280, height: 720 },
  browser: "chromium",
});
console.log("enqueued run", run.id);
await q.close();
await close();
```

Run it with your project id from step 8:

```bash
PROJECT_ID=<projectId> \
  pnpm exec node --experimental-vm-modules scripts/enqueue-capture.mjs
```

The `capture-worker` will pick up the job, navigate to the target URL,
write the screenshot to MinIO, and insert a `screenshots` row. The
`diff-worker` then resolves the baseline (none on a variation's first run —
approve the candidate in the dashboard to set it) and emits a diff row.

</details>

## 12. Verify the diff renders

Open the **Inbox** (the review queue) or the build under
**/projects/&lt;projectId&gt;/builds**. The first run for a variation has no
baseline yet — open it and **Approve** the candidate to set the first baseline.
Upload a **different** image for the same checkpoint (reuse `name` / `viewport`
/ `browser`), and the diff-worker flags it: it lands in the Inbox as
**Unresolved**, and the diff viewer shows baseline vs candidate with the changed
regions highlighted. Approve to promote the candidate, or reject to keep the
current baseline.

## Next steps

- **CI integration**: REST upload (§11) + the GitHub App PR-comment flow are
  shipped; see [`docs/integrations/github-actions.md`](../integrations/github-actions.md).
- **Slack / webhook notifications**: shipped via the `integrations` service
  (set `SLACK_WEBHOOK_URL` / `GITHUB_APP_*` in `.env`).
- **SDK**: the Kotlin SDK ships across Selenium, Playwright, and Appium
  (`io.github.qasecret:furan-*`). Plain curl (§11) remains a transport-agnostic
  substitute.
- **Production deployment**: per-app images + `docker compose up -d` are
  shipped — see [`docs/runbooks/production-deploy.md`](../runbooks/production-deploy.md).
- **VLM-narrated diff explanations**: the diff engine's VLM layer is image-first
  (ADR-047) — it runs only when L1 detects a pixel diff.

## Troubleshooting

**Compose port collisions**. If `5433`, `6379`, `9000`, or `9001` are
already bound on your host, edit `infra/docker/compose.dev.yml` to remap
them, then re-run `docker compose ... up -d`. Don't forget to update
`DATABASE_URL` / `REDIS_URL` / `S3_ENDPOINT` in `.env` to match.

**`JWT_SECRET must be ≥32 chars (fail-closed)`**. The api refuses to boot
with a short or missing JWT secret. Re-run `openssl rand -hex 32` and
paste the full output.

**Migration errors after schema drift**. For dev hosts only:

```bash
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml down -v
docker compose -f infra/docker/compose.yml -f infra/docker/compose.dev.yml up -d
pnpm --filter @furan/db db:migrate
```

The `-v` flag drops the postgres / redis / minio volumes, which is
destructive — never do this on a real install. For a Docker-only install,
omit the `db:migrate` line — the `migrate` service in `compose.yml`
re-applies on the next `up -d`.

**`migrate` service exited non-zero**. Check `docker compose logs
migrate`. The most common cause is a partially-applied prior migration
left over from a manual `psql` run; remove the matching row from
`drizzle.__drizzle_migrations` and re-run `docker compose up -d` so the
service replays it. For first installs on a fresh volume there is nothing
to clean up — the failure points at the migration SQL itself, which
should be reported as a bug against the failing file in
`packages/db/migrations/`.

**Dashboard says "Cannot connect to API"**. Check that
`NEXT_PUBLIC_API_URL` in `.env` matches where the api is actually
listening (default `http://localhost:3000`). Next.js inlines this value
at build time; restart `pnpm --filter @furan/dashboard dev` after
changing it.

**Capture or diff jobs never run**. Confirm both workers are running and
that Redis is reachable: `docker compose ... exec redis redis-cli ping`
should print `PONG`. Worker logs print `capture_job_received` /
`diff_job_received` lines when they pick up work.

**MinIO bucket missing**. The `minio-init` one-shot creates the
`MINIO_BUCKET` on first start. If you change `MINIO_BUCKET` in `.env`,
restart compose so the init container re-runs.
