# E2E verification report — fresh production deploy, 2026-06-24

> A fresh-from-wiped-volumes deploy of the Docker-Compose production stack,
> followed by a manual end-to-end walk of the full review loop (admin →
> project → members → PAT → capture → first baseline → diff → approve/reject).
> Companion to [`production-deploy.md`](production-deploy.md). Screenshots are
> in [`assets/e2e-2026-06-24/`](assets/e2e-2026-06-24/).

## Verdict

**The product works end-to-end** once the stack is on a consistent
image+migration revision. The _documented_ deploy (pinned `v1.1.22` images +
current-tree migrations) is **broken on arrival** — a blocking image/migration
drift that health checks do not catch (see **D1**). After repinning to the
`origin/main` commit-SHA images, every core flow passed: capture ingest,
manual first-baseline (ADR-036), pixel diff + viewer, approve→promote, and
baseline history. Seven secondary issues were found (one medium, the rest low).

## Environment

| Field      | Value                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| Host       | macOS (Darwin 25.4.0), Docker 28.0.4                                        |
| Stack      | `infra/docker/compose.yml` + `compose.main-images.yml`, project `docker`    |
| App images | repinned `v1.1.22` → `origin/main` `ca6ef79` (commit-SHA build, 2026-06-24) |
| Data plane | postgres:17-alpine, redis:7-alpine, minio (S3 profile)                      |
| Migrations | 29 applied, 0 skipped (`migrate` one-shot)                                  |
| Admin      | auto-seeded `admin@local.test` via `FURAN_BOOTSTRAP_ADMIN_*`                |
| Drove via  | dashboard in Playwright (real browser) + `curl`/PAT for SDK ingest          |

## Deploy result

`docker compose … down -v` (wiped 9-day-old volumes) → `up -d`. All 8
long-running services reached healthy; `migrate` + `minio-init` exited 0.

```
api ✓  capture-worker ✓  diff-worker ✓  integrations ✓  dashboard ✓
postgres ✓  redis ✓  minio ✓
/livez 200 · /readyz {postgres:ok, redis:ok, s3:ok} · /login 200
```

## Step-by-step results

| #   | Step                                                        | Surface                   | Result                                                                   |
| --- | ----------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| 1   | Stack up, migrations, health, admin auto-seed               | compose / API             | ✅                                                                       |
| 2   | Admin login → landing on default project                    | browser                   | ✅ landed on `…/builds` via `resolveLanding`                             |
| 3   | Create project                                              | API `POST /projects`      | ✅ 201 (after **D1** fix; 500 before)                                    |
| 4   | Dashboard renders project, SDK hint, empty state            | browser                   | ✅ shows `furan-selenium:4.0.0`, API URL                                 |
| 5   | Mint PAT (one-shot dialog)                                  | browser `/account/tokens` | ✅ `furan_pat_…`, shown once, ack-gated close — **F3**                   |
| 6   | Create editor user                                          | browser `/admin/members`  | ✅ table refreshed immediately                                           |
| 7   | Assign membership + default project                         | browser                   | ✅ editor login sees exactly 1 project                                   |
| 8   | Build → Run 1 → upload image A → complete                   | curl + PAT                | ✅ 201/201/200/200                                                       |
| 9   | First-baseline review (no prior baseline)                   | browser diff viewer       | ✅ "No baseline yet"; Approve → New→Passed; ADR-036                      |
| 10  | Build → Run 2 → upload image B (same checkpoint) → complete | curl + PAT                | ✅ same `testVariationId`                                                |
| 11  | Diff detection vs approved baseline                         | diff-worker               | ✅ `diffPercent 1.44%`, 13 237 px, tier `l1`, `this_branch`              |
| 12  | Unresolved run surfaces in Inbox                            | browser `/inbox`          | ✅ queued — **F5**                                                       |
| 13  | Diff viewer renders baseline/candidate + regions            | browser (pixi.js)         | ✅ side-by-side, 2 highlighted regions, "why changed: cosmetic" — **F6** |
| 14  | Approve checkpoint → promote candidate                      | browser                   | ✅ run → Passed; **F4**                                                  |
| 15  | Baseline history records both baselines                     | browser                   | ✅ 2 entries (A @ 21:17, B @ 21:21), newest first                        |
| 16  | Inbox clears after approve                                  | browser                   | ✅ "All clear"                                                           |
| 17  | Run 3 (image A) diffs vs promoted baseline B                | curl + diff-worker        | ✅ 1.42%; content-addressed dedup (same `imageKey` as run 1)             |
| 18  | Reject run 3 via inbox quick-action                         | browser + API             | ⚠️ decision recorded (200) but run stays queued — **F1**                 |
| 19  | Live SSE refresh of list views                              | browser                   | ✅ builds/runs appeared without manual refetch                           |

## Findings

### D1 — Pinned release image is incompatible with current migrations (**blocking**, fixed)

`compose.yml` pins `qasecret/furan-*:v1.1.22`, but the working tree is **38
commits / 8 migrations ahead**. Migration `0024_slim_hulk.sql` drops
`projects.l2_enabled` (ADR-047 L2 deletion, #266), which the v1.1.22 image
still queries:

```
PostgresError: column "l2_enabled" of relation "projects" does not exist
→ GET /projects 500, POST /projects 500 (masked as 409, see F7)
```

`/livez` + `/readyz` stayed **green** throughout — they don't touch the
drifted tables — so the break is invisible to health checks. **Root cause:**
the `migrate` service applies local-checkout migrations while the app runs a
pinned image; the semver app-image release has fallen behind `main`.
**Fix applied:** repinned the five app images to the published `origin/main`
commit-SHA build (`ca6ef79`), whose migrations match the tree byte-for-byte.
Full write-up + prevention in [`production-deploy.md` §0](production-deploy.md#0-the-one-rule-that-bites-everyone-image--migration-lockstep).
**Recommended permanent fix:** cut a new `v1.1.x` release so the documented
`docker compose up -d` works from a release checkout again.

### F1 — Inbox quick-Reject gives no reviewer feedback (medium, UX)

`inbox.reject` returns 200 and inserts a `runReviewerDecisions` row
(`decision="rejected"`), but by design it does **not** change
`test_runs.status`. The inbox filters on status (`All open` / `Unresolved` /
`Failed` — there is **no "Rejected" view**), so a rejected run **remains in the
queue unchanged across reloads**, with the same Approve/Reject actions. Approve,
by contrast, resolves the run and clears it. Net effect: clicking Reject in the
inbox looks like a no-op. Consider either reflecting the decision in the row
(badge / move to a "Rejected" filter) or rolling the run to a terminal state.

### F2 — PAT "Last used" never updates (low)

`tokens.lastUsedAt` exists in the schema and is surfaced in the API + UI, but
**no code writes it** (no UPDATE in `apps/api/src`). The PAT authenticated ~12
ingest requests; `lastUsedAt` stayed `null` ("—" in the UI). The column is
effectively dead — either wire the update (throttled is fine) or drop the
column + UI affordance.

### F3 — Token table doesn't refresh after create (low, UX)

After minting a PAT, the tokens table still showed "No tokens yet" until a
manual reload. The create mutation doesn't invalidate the token-list query.

### F4 — Diff-viewer checkpoint chip stale after approve (low, UX)

Approving promoted the run to **Passed** (header + status panel updated), but
the left-rail checkpoint chip still read **"Unresolved"** until reload. Partial
cache invalidation on the approve mutation.

### F5 — Inbox preview shows "No preview image" (low, UX)

The inbox right-rail preview never rendered a thumbnail for an unresolved run
("No preview image"), even though the full diff viewer renders both images
fine. Thumbnail generation/serving gap for the inbox preview.

### F6 — Inbox "Open full diff" deep-link 404s transiently (low)

The inbox "Open full diff" link is `/runs/<runId>/diffs/<runId>` — it uses the
**runId as the diff/checkpoint id**. On load that yields 3 console 404s on
`runs.getCheckpointGroup` (checkpointId == runId) before the viewer resolves
the real `checkpointId` and re-navigates. Functionally self-corrects, but the
initial bad URL is avoidable by linking the real checkpoint id.

### F7 — `POST /projects` masks all insert errors as 409 (low, code quality)

The project-create handler's `catch` returns `409 project_name_taken` for
**any** insert failure. During D1 this turned a schema error
(`l2_enabled does not exist`) into a misleading "name taken" 409, costing
diagnosis time. Narrow the catch to the unique-violation code (`23505`).

## What passed cleanly (no issues)

Deploy health & migrations · admin auto-seed · admin login & landing resolver ·
project create (post-fix) · PAT one-shot mint & format · editor create + role +
membership + default-project scoping · SDK-style REST ingest over PAT
(build/run/screenshot-base64/complete) · manual first-baseline (ADR-036) ·
L1 pixel diff + percentages + cluster localization · diff viewer
(side-by-side, region highlight, "why this changed") · approve→promote ·
baseline history · inbox queue + clear-on-approve · live SSE · content-addressed
screenshot dedup.

## Reproduction artifacts

- Fixtures: two 1280×720 PNGs differing in two regions (button colour + badge).
- Project `E2E Smoke 2026-06-24` (`6b839a10…`), users `admin@local.test` /
  `editor@local.test`, variation `homepage` (1280×720 / chromium / main).
- Screenshots: `assets/e2e-2026-06-24/01..06-*.png`.
