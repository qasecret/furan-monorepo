# Architecture

Source of truth for Furan's architecture lives in the
[`furan-design`](https://github.com/qasecret/furan-design) repository
(filesystem path on the maintainer's machine: `/Workspace/furan/furan-design/`).
Authoritative docs:

- [`arch-overview.md`](https://github.com/qasecret/furan-design/blob/main/arch-overview.md) — services + data flow + deployment topology
- [`arch-backend.md`](https://github.com/qasecret/furan-design/blob/main/arch-backend.md) — Fastify + tRPC + Drizzle backend shape
- [`arch-frontend.md`](https://github.com/qasecret/furan-design/blob/main/arch-frontend.md) — Next.js 15 + pixi.js diff viewer
- [`arch-sdk.md`](https://github.com/qasecret/furan-design/blob/main/arch-sdk.md) — Kotlin SDK + Selenium adapter
- [`sec-identity.md`](https://github.com/qasecret/furan-design/blob/main/sec-identity.md) — simplified auth (email + password + JWT + `furan_pat_*` tokens)
- [`ops-devex.md`](https://github.com/qasecret/furan-design/blob/main/ops-devex.md) — monorepo layout + CI + container hardening + self-host
- [`ops-observability.md`](https://github.com/qasecret/furan-design/blob/main/ops-observability.md) — pino + OTel + Prometheus + Grafana
- [`plan-roadmap.md`](https://github.com/qasecret/furan-design/blob/main/plan-roadmap.md) — phased delivery
- [`plan-decisions.md`](https://github.com/qasecret/furan-design/blob/main/plan-decisions.md) — ADRs

## Current state — Phase 0 (this tag: `v0.1-scaffold`)

Monorepo scaffold only: Turborepo + pnpm workspaces, shared
`packages/eslint-config` + `packages/tsconfig`, governance files,
CI green-on-zero-tasks. **No application code yet** — `apps/` and
`packages/` (other than the dev-config ones) are empty.

Phase 1 (`v0.2-backend-core`) lands `packages/db` (Drizzle), `apps/api`
(Fastify + tRPC + Zod + `@fastify/jwt` + `requireProjectMember(action)`
from day one), `apps/dashboard` shell, worker scaffolds, and the full
observability spine.

## Archived predecessor repos

The previous `furan-backend` (NestJS+Prisma placeholder), `furan-frontend`
(Vite+MUI+Konva placeholder), and `furan-sdk` (Kotlin seed) lived at
`/Workspace/furan/furan-{backend,frontend,sdk}/`. They contained no
production code and no users; this monorepo is a fresh start per
[ADR-029](https://github.com/qasecret/furan-design/blob/main/plan-decisions.md#adr-029--green-field-v10-build-in-workspacefuran-monorepo-discard-strangler-fig).
Do **not** import code or schemas from those directories.
