# Hosting the documentation portal

The portal (`apps/docs`, ADR-081) is one Docusaurus source with three builds.
Each build sets `DOCS_BASE_URL` and `DOCS_SITE_URL` (read by
[`apps/docs/docusaurus.config.ts`](../../apps/docs/docusaurus.config.ts)):

| Build             | Where                                            | Built by                                                         | When                      | `DOCS_BASE_URL`    | `DOCS_SITE_URL`              |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------- | ------------------------- | ------------------ | ---------------------------- |
| Bundled           | `/docs` on every install                         | [`apps/dashboard/Dockerfile`](../../apps/dashboard/Dockerfile)   | each image build          | unset (`/docs/`)   | unset                        |
| GitHub Pages      | <https://qasecret.github.io/furan-monorepo/>     | [`.github/workflows/docs.yml`](../../.github/workflows/docs.yml) | `v*` release tags         | `/furan-monorepo/` | `https://qasecret.github.io` |
| Cloudflare Worker | `https://furan-monorepo.<subdomain>.workers.dev` | Cloudflare Workers Builds (settings below)                       | every push to `main`, PRs | `/`                | the Worker's URL             |

GitHub Pages describes the latest release. The Cloudflare Worker follows
`main`, so between releases it can document features the published images
don't have yet, and each pull request gets its own preview URL.

## Cloudflare Worker

The Worker serves the static build as
[static assets](https://developers.cloudflare.com/workers/static-assets/) with
no Worker script; [`apps/docs/wrangler.jsonc`](../../apps/docs/wrangler.jsonc)
configures it. Cloudflare builds and deploys it, not GitHub Actions, so it
needs no repository secrets. Wrangler isn't a dependency (the dashboard image's
docs stage installs `@furan/docs...` and shouldn't carry it): the `wrangler`
script in [`apps/docs/package.json`](../../apps/docs/package.json) runs a
pinned version through `pnpm dlx`.

A Cloudflare account admin sets it up once: **Workers & Pages → Create →
Import a repository**, pick `qasecret/furan-monorepo` (this installs
Cloudflare's GitHub app on the org), name the Worker `furan-monorepo` (the
`name` in `wrangler.jsonc`), and under **Settings → Build** enter:

| Setting         | Value                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- |
| Git branch      | `main`                                                                                    |
| Root directory  | `apps/docs` (Workers Builds reads `wrangler.jsonc` from here)                             |
| Build command   | `pnpm install --frozen-lockfile --filter '@furan/docs...' --ignore-scripts && pnpm build` |
| Deploy command  | `pnpm run wrangler deploy`                                                                |
| Preview command | `pnpm run wrangler preview`                                                               |

Build variables:

| Variable                  | Value                                            | Why                                                                                  |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `PNPM_VERSION`            | `9.15.0`                                         | The repo pins pnpm 9.15.0 (`packageManager`); the build image's default differs.     |
| `SKIP_DEPENDENCY_INSTALL` | `1`                                              | Skips Cloudflare's full-workspace install; the build command installs only the docs. |
| `DOCS_BASE_URL`           | `/`                                              | The site is served at the root of its hostname.                                      |
| `DOCS_SITE_URL`           | `https://furan-monorepo.<subdomain>.workers.dev` | Canonical links and the sitemap. Use the custom domain instead once one is attached. |

Node comes from [`.nvmrc`](../../.nvmrc). Under **Settings → Build → Build
watch paths**, include `docs/*`, `apps/docs/*`,
`packages/sdk-kotlin/version.txt` and `pnpm-lock.yaml`, and exclude
`docs/maintainers/*` (never published), so the rest of the monorepo doesn't
trigger a docs build.

With `html_handling: "auto-trailing-slash"` the Worker serves `x.html` at `/x`
and redirects `/x.html` and `/x/` there, which is what `trailingSlash: false`
expects; `not_found_handling: "404-page"` serves the portal's `404.html` for
unknown paths. To reproduce the Cloudflare build locally:

```bash
DOCS_BASE_URL=/ pnpm --filter @furan/docs build
pnpm --filter @furan/docs run wrangler dev
```

The build fails on a broken link or anchor and on markup the bundled `/docs`
CSP would block, so a change that passes the `docs` PR check builds on
Cloudflare too.
