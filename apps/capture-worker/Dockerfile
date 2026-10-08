# syntax=docker/dockerfile:1.7
# apps/capture-worker — BullMQ consumer that drives Playwright/chromium
# to render pages and snap screenshots.
#
# Runtime base is mcr.microsoft.com/playwright (NOT distroless) because
# chromium needs nss, libgbm, libxkbcommon, fonts, and a stack of other
# shared libs that distroless intentionally omits. The playwright image
# ships them all + the right chromium build for the playwright version.
#
# Build context = repo root.

#####################################################################
# Stage 1: deps                                                      #
#####################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/capture-worker/package.json apps/capture-worker/

COPY packages/config/package.json         packages/config/
COPY packages/db/package.json             packages/db/
COPY packages/diff-engine/package.json    packages/diff-engine/
COPY packages/eslint-config/package.json  packages/eslint-config/
COPY packages/queue/package.json          packages/queue/
COPY packages/shared-types/package.json   packages/shared-types/
COPY packages/storage/package.json        packages/storage/
COPY packages/telemetry/package.json      packages/telemetry/
COPY packages/tsconfig/package.json       packages/tsconfig/

# --ignore-scripts to skip:
#   - root `prepare` (lefthook install — needs git)
#   - playwright's postinstall (it tries to download browsers, but the
#     runtime stage uses the playwright image which already has them)
#   - sharp/msgpackr-extract node-gyp paths
RUN pnpm install --frozen-lockfile --filter @furan/capture-worker... --ignore-scripts

#####################################################################
# Stage 2: build                                                     #
#####################################################################
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/capture-worker/ apps/capture-worker/

# Re-install with --ignore-scripts to skip the workspace-root `prepare`
# (which calls `lefthook install` and needs git on PATH — `node:22-bookworm-slim`
# doesn't ship git), then explicitly run `pnpm rebuild sharp` so sharp's
# prebuilt binary lands in node_modules.
#
# Playwright's browser download is suppressed via PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# because the runtime image ships chromium itself (saves ~300MB of redundant
# downloads in the build layer).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --filter @furan/capture-worker... --prefer-offline --ignore-scripts \
  && pnpm rebuild sharp

RUN pnpm --filter @furan/capture-worker... build

# Re-install with NODE_ENV=production to strip dev/build-time deps
# (esbuild via tsx & vitest, lefthook, vitest, etc.) from node_modules.
# `pnpm prune --prod` only sweeps the workspace ROOT manifest's devDeps;
# tsx/vitest are declared in apps/capture-worker/package.json devDeps,
# so prune leaves their transitive @esbuild Go binaries in place where
# Trivy flags them as dormant stdlib CVE sources.
#
# Rebuild-from-scratch is the most predictable fix: delete node_modules,
# re-resolve with NODE_ENV=production so pnpm skips every devDep section
# (root and per-package), then rebuild sharp's prebuilt binary.
ENV NODE_ENV=production
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --filter @furan/capture-worker... --prefer-offline --ignore-scripts \
  && pnpm rebuild sharp

#####################################################################
# Stage 3: runtime — Playwright base (jammy)                         #
#####################################################################
# Pin to a Playwright image matching the npm `playwright` version range
# in apps/capture-worker/package.json (^1.60). Noble (Ubuntu 24.04) base
# carries newer OS package versions than jammy (Ubuntu 22.04), which
# eliminates the dirmngr/git/gnupg/libtiff5 HIGH CVEs Trivy flagged on
# the prior v1.50.0-jammy base. Bumping the Playwright npm dep in lockstep
# refreshes the bundled glob/minimatch/tar transitive deps too.
FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Patch base-image CVEs the Trivy release gate blocks (both fixed upstream):
#   - libssl3t64: openssl PKCS7_verify() Heap-UAF (CVE-2026-45447) — apt
#     pulls noble's patched point release.
#   - the Playwright base's bundled GLOBAL npm ships a vulnerable sigstore
#     (CVE-2026-48815, npm's provenance dep). The runtime entrypoint is
#     `node apps/capture-worker/dist/server.js` — npm/npx are never invoked
#     — so remove the global npm/corepack tooling rather than ship a dormant
#     HIGH CVE. `npm root -g` locates it regardless of the base's node layout.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends --only-upgrade libssl3t64; \
    rm -rf /var/lib/apt/lists/*; \
    npm_root="$(npm root -g 2>/dev/null || echo /usr/lib/node_modules)"; \
    rm -rf "$npm_root/npm" "$npm_root/corepack"; \
    for b in npm npx corepack; do \
      p="$(command -v "$b" 2>/dev/null || true)"; [ -n "$p" ] && rm -f "$p" || true; \
    done

# Non-root runtime user. The mcr.microsoft.com/playwright image runs as
# root by default; create a least-privileged user and chown the app tree.
RUN groupadd -r furan && useradd -r -g furan -d /app furan

# pnpm's isolated node-linker places per-package symlinks under
# apps/capture-worker/node_modules; Node's ESM resolver walks UP from the
# entry point, so apps/capture-worker/node_modules/@furan/config (the
# workspace-package symlink) is required — copying only /app/node_modules
# leaves the resolver to fail with ERR_MODULE_NOT_FOUND on first import.
COPY --from=build --chown=furan:furan /app/node_modules                          ./node_modules
COPY --from=build --chown=furan:furan /app/apps/capture-worker/node_modules      ./apps/capture-worker/node_modules
COPY --from=build --chown=furan:furan /app/packages                              ./packages
COPY --from=build --chown=furan:furan /app/apps/capture-worker/dist              ./apps/capture-worker/dist
COPY --from=build --chown=furan:furan /app/apps/capture-worker/package.json      ./apps/capture-worker/package.json
COPY --from=build --chown=furan:furan /app/package.json                          ./package.json
COPY --from=build --chown=furan:furan /app/pnpm-workspace.yaml                   ./pnpm-workspace.yaml

USER furan
EXPOSE 3100

# Worker exposes a node:http health server on PORT (default 3100).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/capture-worker/dist/server.js"]
