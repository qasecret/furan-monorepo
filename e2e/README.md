# @furan/e2e — end-to-end test suite

Boots a **Docker-from-HEAD** Furan deployment and validates it end to end —
deploy → SDK-triggered runs → diff pipeline → dashboard UI — across the major
configs, emitting a **capability-coverage matrix**. Playwright Test is the
runner; a TypeScript "virtual SDK" replays the SDK's REST wire flow for breadth.

Design/plan: `furan-design/specs/2026-07-02-e2e-suite-design.md`,
`furan-design/plans/2026-07-02-e2e-suite.md`.

## Run it

```bash
# One shot: build images (if missing) → compose up (S3) → seed → test → down
pnpm --filter @furan/e2e e2e

# Keep the stack up between iterations, then run Playwright directly:
pnpm --filter @furan/e2e e2e:up
E2E_API_URL=http://localhost:3010 E2E_DASH_URL=http://localhost:3011 \
  pnpm --filter @furan/e2e exec playwright test --project=s3-full
pnpm --filter @furan/e2e e2e:down

# HDD storage smoke (separate deployment):
pnpm --filter @furan/e2e e2e:hdd

# Coverage gate (fails only on a REGRESSED capability):
pnpm --filter @furan/e2e coverage      # reads e2e-coverage.json
```

The stack is isolated on host ports **3010** (api) / **3011** (dashboard) via
`scripts/compose.e2e-ports.yml` so it coexists with a dev `pnpm dev` on
3000/3001. Output: `e2e-coverage.md` / `e2e-coverage.json` + `playwright-report/`.

## Prerequisites

- A healthy **Docker daemon** (the from-HEAD image build is heavy). If a build
  fails with a BuildKit I/O error, `docker builder prune -f` / restart Docker.
- The 5 `qasecret/furan-*:local` images (the orchestrator builds any missing).
- `playwright install chromium` (once) for the UI tests.
- Optional: a JDK (real Kotlin-SDK smoke) and a local **ollama** (VLM layer) —
  absent → those capabilities are marked *config-gated*, not failed.

## Layout

```
scripts/    e2e.ts (orchestrator) · compose.ts · wait-health.ts · global-setup.ts
            check-coverage.ts · compose.e2e-ports.yml
src/        env.ts (canonical URLs) · clients/{api-client,virtual-sdk} ·
            seed/{seed,load-seed} · coverage/{manifest,reporter} · fixtures/*.png
tests/      deploy · sdk · diff · rbac · branch · storage · ui
```

## Coverage matrix

`src/coverage/manifest.ts` is the capability denominator; each test tags the
IDs it covers via `coverAnnotations([...])`; the reporter renders
`area → capability → state` (passed / failed / config-gated / MISSING). Add a
capability by adding it to the manifest and tagging a test.

## Known constraints

- **`ui.diff_viewer` is skipped on the coexistence ports.** The dashboard
  browser bundle bakes `NEXT_PUBLIC_API_URL` at build time (default
  `localhost:3000`) for *client-side* fetches, while SSR reads it from the
  runtime env. With the api remapped to 3010, no single baked URL serves both.
  Server-rendered pages (login, builds, admin) work; client-data pages (the
  pixi diff viewer) need the api on the standard port **3000** — a
  dedicated-ports run (stop dev servers) or CI.
- **`branch.parent_fallback` is skipped** pending a product-side investigation
  (an identical feature-branch capture returns `new`, not `passed`).
- **Element-map-dependent** diff capabilities (ignore/layout regions, axe a11y,
  auto-rules) need the multipart + element-map upload path; the base64 variant
  the virtual-SDK uses omits `matchLevel`/`regions`.

## CI

`.github/workflows/e2e.yml` runs this suite on `workflow_dispatch` + a nightly
schedule — never on push/PR (too heavy, and needs a full compose stack). It
synthesizes an ephemeral `infra/docker/.env` with runtime-random secrets,
builds the images, runs `e2e:s3`, gates on coverage, and uploads the matrix +
report.
