# Furan

**Self-hostable visual regression testing for small teams.**
Install with `docker compose up -d`, hook into CI in one workflow file,
branch-aware baselines that don't pollute `main`.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/qasecret/furan-monorepo/ci.yml?branch=main&label=CI)](https://github.com/qasecret/furan-monorepo/actions)

> **Status: Phase 0 scaffold (`v0.1-scaffold`).** This monorepo currently
> contains structure only — no working application. The first usable
> backend lands in Phase 1 (`v0.2-backend-core`).
> See [furan-design/plan-roadmap.md](https://github.com/qasecret/furan-design/blob/main/plan-roadmap.md).

## Why Furan (target v1.0)

- **Install in under 30 minutes** on a single Hetzner-AX52-class host.
- **Branch-aware baselines** with fallback chain (feature → PR base → default) and atomic merge-promotion.
- **GitHub App** that drops sticky PR comments + status checks + auto-promotion on merge (Phase 4).
- **Apache 2.0**, no telemetry on the server, no upgrade gate.

## Quickstart (target — not yet functional)

```bash
git clone https://github.com/qasecret/furan-monorepo && cd furan-monorepo
cp .env.example .env   # set JWT_SECRET and POSTGRES_PASSWORD once Phase 1 lands
docker compose up -d   # Phase 1+
```

For now, contributors run `pnpm install && pnpm lint && pnpm test` to verify
the scaffold.

## Repository layout

```
furan/
├── apps/                 # capture-worker, diff-worker, api, dashboard, integrations (Phase 1+)
├── packages/             # db, storage, queue, telemetry, shared-types, … (Phase 1+)
│   ├── eslint-config/    # shared lint config (Phase 0)
│   └── tsconfig/         # shared TS config   (Phase 0)
├── infra/docker/         # compose files      (Phase 1+)
└── docs/                 # runbooks + self-hosting (Phase 5)
```

## What v1.0 will ship

| Capability | v1.0 |
|---|---|
| Visual diff pipeline | L1 (odiff pixel) + L2 (DOM diff via `diff-dom`) |
| Diff viewer | Side-by-side, overlay, onion-skin, heatmap, viewport switcher |
| Branch-aware baselines | Fallback chain + GitHub App merge promotion |
| Authentication | Email + password + JWT |
| RBAC | 3 roles (admin / editor / guest) gated by project membership |
| SDK | Kotlin (`io.furan:sdk-core` + `io.furan:sdk-selenium`) |
| Self-host | Docker Compose; documented under 30 min |

The full feature list and v1.1+ roadmap (TypeScript SDK, GitLab/Bitbucket/Azure DevOps bots, multi-tenancy, SSO, audit log, and more) lives in [furan-design/plan-roadmap.md](https://github.com/qasecret/furan-design/blob/main/plan-roadmap.md).

## License + governance

- [LICENSE](LICENSE) — Apache 2.0
- [SECURITY.md](SECURITY.md) — disclosure
- [CONTRIBUTING.md](CONTRIBUTING.md) — DCO + setup
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [ARCHITECTURE.md](ARCHITECTURE.md) — pointer at the `furan-design` repo
