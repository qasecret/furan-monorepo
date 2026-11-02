# Hosting the documentation portal

The portal (`apps/docs`, ADR-081) is one Docusaurus source with three builds.
Each build sets `DOCS_BASE_URL` and `DOCS_SITE_URL` (read by
[`apps/docs/docusaurus.config.ts`](../../apps/docs/docusaurus.config.ts)):

| Build            | Where                                        | Built by                                                         | When                      | `DOCS_BASE_URL`    | `DOCS_SITE_URL`                |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------- | ------------------------- | ------------------ | ------------------------------ |
| Bundled          | `/docs` on every install                     | [`apps/dashboard/Dockerfile`](../../apps/dashboard/Dockerfile)   | each image build          | unset (`/docs/`)   | unset                          |
| GitHub Pages     | <https://qasecret.github.io/furan-monorepo/> | [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml) | `v*` release tags         | `/furan-monorepo/` | `https://qasecret.github.io`   |
| Cloudflare Pages | <https://furan-docs.pages.dev>               | Cloudflare's Git integration (settings below)                    | every push to `main`, PRs | `/`                | `https://furan-docs.pages.dev` |

GitHub Pages describes the latest release. Cloudflare Pages follows `main`, so
between releases it can document features the published images don't have yet,
and each pull request gets its own preview URL.

## Cloudflare Pages project

The build runs on Cloudflare, not in GitHub Actions, so it needs no repository
secrets. A Cloudflare account admin sets it up once: **Workers & Pages →
Create → Pages → Connect to Git**, pick `qasecret/furan-monorepo` (this
installs Cloudflare's GitHub app on the org), and enter:

| Setting                | Value                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| Project name           | `furan-docs` (sets the `furan-docs.pages.dev` hostname)                                                        |
| Production branch      | `main`                                                                                                         |
| Framework preset       | None                                                                                                           |
| Root directory         | _(empty — the repository root)_                                                                                |
| Build command          | `pnpm install --frozen-lockfile --filter '@furan/docs...' --ignore-scripts && pnpm --filter @furan/docs build` |
| Build output directory | `apps/docs/build`                                                                                              |

Environment variables, for both Production and Preview:

| Variable                  | Value                          | Why                                                                                  |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `PNPM_VERSION`            | `9.15.0`                       | Build image v3 defaults to pnpm 10; the repo pins 9 (`packageManager`).              |
| `SKIP_DEPENDENCY_INSTALL` | `1`                            | Skips Cloudflare's full-workspace install; the build command installs only the docs. |
| `DOCS_BASE_URL`           | `/`                            | The site is served at the root of its hostname.                                      |
| `DOCS_SITE_URL`           | `https://furan-docs.pages.dev` | Canonical links and the sitemap.                                                     |

Node comes from [`.nvmrc`](../../.nvmrc). Under **Settings → Builds → Build
watch paths**, include `docs/*`, `apps/docs/*`,
`packages/sdk-kotlin/version.txt` and `pnpm-lock.yaml`, and exclude
`docs/maintainers/*` (never published), so the rest of the monorepo doesn't
trigger a docs build.

Pages serves `x.html` at `/x` and redirects `/x.html` and `/x/` there, which is
what `trailingSlash: false` expects, and serves the portal's `404.html` for
unknown paths. To reproduce a Cloudflare build locally:

```bash
DOCS_BASE_URL=/ DOCS_SITE_URL=https://furan-docs.pages.dev pnpm --filter @furan/docs build
npx wrangler pages dev apps/docs/build
```

The build fails on a broken link or anchor and on markup the bundled `/docs`
CSP would block, so a change that passes the `docs` PR check builds on
Cloudflare too.
