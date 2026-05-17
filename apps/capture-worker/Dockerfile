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

# Re-install WITH scripts so sharp's prebuilt binary lands in node_modules.
# Playwright's browser download is suppressed via PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# because the runtime image ships chromium itself (saves ~300MB of redundant
# downloads in the build layer).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --filter @furan/capture-worker... --prefer-offline \
  || pnpm rebuild sharp

RUN pnpm --filter @furan/capture-worker... build

#####################################################################
# Stage 3: runtime — Playwright base (jammy)                         #
#####################################################################
# Pin to a Playwright image matching the npm `playwright` version range
# in apps/capture-worker/package.json (^1.49). v1.50 is the closest tagged
# upstream image at the time of writing.
FROM mcr.microsoft.com/playwright:v1.50.0-jammy AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Non-root runtime user. The mcr.microsoft.com/playwright image runs as
# root by default; create a least-privileged user and chown the app tree.
RUN groupadd -r furan && useradd -r -g furan -d /app furan

COPY --from=build --chown=furan:furan /app/node_modules                       ./node_modules
COPY --from=build --chown=furan:furan /app/packages                           ./packages
COPY --from=build --chown=furan:furan /app/apps/capture-worker/dist           ./apps/capture-worker/dist
COPY --from=build --chown=furan:furan /app/apps/capture-worker/package.json   ./apps/capture-worker/package.json
COPY --from=build --chown=furan:furan /app/package.json                       ./package.json
COPY --from=build --chown=furan:furan /app/pnpm-workspace.yaml                ./pnpm-workspace.yaml

USER furan
EXPOSE 3100

# Worker exposes a node:http health server on PORT (default 3100).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/capture-worker/dist/server.js"]
