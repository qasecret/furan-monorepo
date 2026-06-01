# Furan — install quickstart (v0.4 alpha)

> Target: a maintainer or alpha installer should reach "first diff visible in the
> dashboard" in under 30 minutes from a freshly provisioned host.
> Re-installs (cached pnpm + docker layers) should land under 10 minutes.

## What is Furan?

Furan is an Apache-2.0, self-hostable visual regression testing platform aimed at
small teams. You point your CI at a Furan server, it captures screenshots of your
app under test, compares them against an approved baseline, and surfaces a
pixel-accurate diff in the dashboard for human review and approval.

This guide installs the v0.4 alpha stack: a Dockerised data plane (Postgres +
Redis + MinIO) plus the Node 22 app services run from source via `pnpm dev`.
Image-based per-app deployment lands in Phase 4 — see "Next steps" below.

## Prerequisites

| Tool    | Version             | Why                                            |
| ------- | ------------------- | ---------------------------------------------- |
| Docker  | 24+ with Compose v2 | Postgres / Redis / MinIO data plane            |
| Node.js | 22 LTS              | api / dashboard / capture-worker / diff-worker |
| pnpm    | 9.15+               | Workspace package manager                      |
| openssl | any recent          | Generating `JWT_SECRET`                        |

Hardware budget: **~4 GB RAM**, **~10 GB disk** for a single-tenant alpha host.

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
are safe for an alpha host; you only have to set the three passwords plus
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

All four services (`postgres`, `redis`, `minio`, `minio-init`) should report
healthy / exited-0. `minio-init` is a one-shot bucket creator and is
expected to exit after first run.

> **v1.0**: `compose.yml` now boots the **full** stack (data plane + the
> five app services) from pre-built images published to Docker Hub:
> `docker.io/qasecret/furan-{api,dashboard,capture-worker,diff-worker,integrations}:v1.0`.
> A `:latest` tag is also published. GHCR mirrors at
> `ghcr.io/qasecret/furan-*:v1.0` are available for installers who prefer
> GHCR; images are cosign-signed (keyless) and have SBOM artifacts.
>
> The host-process `pnpm dev` flow below is the **development** path. For a
> production-shaped install just run `docker compose -f infra/docker/compose.yml up -d`
> (no `-f compose.dev.yml`); skip the rest of this quickstart's `pnpm`
> sections.

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

## 8. Bootstrap your first project (one-time curl)

There is **no project-create UI in v0.4** — admins create projects via the
REST API. Mint a session token by logging in via the API, then call
`POST /projects`:

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

> A project-create UI ships in v0.5. See
> [`docs/feedback/alpha-1-pending.md`](../feedback/alpha-1-pending.md) for
> the v1.0 GA gap list.

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

## 11. First capture + first diff (v0.4 path)

> **v0.4 limitation**: there is no public REST or SDK endpoint that
> accepts an "upload this screenshot for this build" request from CI yet.
> First-class CI ingestion (REST + Kotlin/Selenium-Java SDKs + a GitHub
> App) lands in Phase 4.

For the v0.4 alpha smoke test, drive the capture queue directly from a
short Node script inside the monorepo. Create a file
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
`diff-worker` will then resolve the baseline (none on first run — it is
auto-promoted) and emit a diff row.

## 12. Verify the diff renders

In the dashboard, navigate to **/projects/&lt;projectId&gt;/runs**. You
should see one row; click it to open the diff viewer at
**/projects/&lt;projectId&gt;/runs/&lt;runId&gt;/diffs/&lt;diffId&gt;**.
The first run becomes its own baseline, so the side-by-side view shows the
same image twice with zero diff regions. Re-run step 11 against a
**different** URL (or the same URL after a UI change) to see a real diff.

## Next steps

- **CI integration**: the GitHub Actions recipe + REST upload + GitHub
  App PR-comment flow ship in **Phase 4 (v0.5)**.
- **Slack / webhook notifications**: also Phase 4.
- **SDKs (Kotlin, Selenium-Java)**: Phase 4. Plain curl + the script
  pattern above is the v0.4 substitute.
- **Production deployment**: per-app images + a single `docker compose up
-d` install lands in Phase 4. For v0.4 alpha hosts, `systemd` units
  wrapping `pnpm --filter ... start` are the supported pattern.
- **VLM-narrated diff explanations**: deferred to v1.1+ per ADR-028.

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
