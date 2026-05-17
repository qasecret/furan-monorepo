# syntax=docker/dockerfile:1.7
# apps/api — Fastify + tRPC. Three-stage build:
#   deps    : install workspace dependencies (cacheable layer)
#   build   : compile TypeScript -> dist/
#   runtime : distroless nodejs22 with non-root user
#
# Build context = repo root (so the pnpm workspace + lockfile resolve).

#####################################################################
# Stage 1: deps — install pnpm + production-relevant dependencies   #
#####################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Root manifests (lockfile is the source of truth for reproducibility)
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./

# App manifest
COPY apps/api/package.json apps/api/

# Workspace package manifests — one explicit COPY each (a bare glob like
# `packages/*/package.json packages/` flattens them all into a single file
# because Docker treats the destination as a path when the source matches
# multiple files in different dirs).
COPY packages/config/package.json         packages/config/
COPY packages/db/package.json             packages/db/
COPY packages/diff-engine/package.json    packages/diff-engine/
COPY packages/eslint-config/package.json  packages/eslint-config/
COPY packages/queue/package.json          packages/queue/
COPY packages/shared-types/package.json   packages/shared-types/
COPY packages/storage/package.json        packages/storage/
COPY packages/telemetry/package.json      packages/telemetry/
COPY packages/tsconfig/package.json       packages/tsconfig/

# `--filter @furan/api...` (note the trailing `...`) pulls @furan/api +
# every workspace dep it depends on, transitively. We can't `--prod` here
# because tsc lives in devDeps and we need it in the build stage.
#
# `--ignore-scripts` skips:
#   - root `prepare` hook (lefthook install — needs git, not in image)
#   - optional native rebuilds (msgpackr-extract, etc. that try node-gyp).
# Required native binaries (sharp, esbuild, etc.) ship prebuilt wheels;
# the capture-worker Dockerfile re-runs install with scripts enabled
# inside the playwright base, which has the toolchain.
RUN pnpm install --frozen-lockfile --filter @furan/api... --ignore-scripts

#####################################################################
# Stage 2: build — compile TypeScript                                #
#####################################################################
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Reuse the deps stage's node_modules + manifests to skip a second install
COPY --from=deps /app /app

# Now layer in sources
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

# Build @furan/api + every workspace package it depends on (turbo would
# pull in too much; explicit filter is cheaper).
RUN pnpm --filter @furan/api... build

#####################################################################
# Stage 3: runtime — distroless, non-root                            #
#####################################################################
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bring over the resolved workspace tree. Distroless has node but no
# package manager — everything must already be in place.
COPY --from=build --chown=nonroot:nonroot /app/node_modules         ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/packages             ./packages
COPY --from=build --chown=nonroot:nonroot /app/apps/api/dist        ./apps/api/dist
COPY --from=build --chown=nonroot:nonroot /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=nonroot:nonroot /app/package.json          ./package.json
COPY --from=build --chown=nonroot:nonroot /app/pnpm-workspace.yaml   ./pnpm-workspace.yaml

USER nonroot
EXPOSE 3000

# Liveness probe hits /livez (defined in apps/api/src/routes/health.ts).
# Uses Node's built-in fetch (Node 22) so we don't need curl/wget in distroless.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["apps/api/dist/server.js"]
