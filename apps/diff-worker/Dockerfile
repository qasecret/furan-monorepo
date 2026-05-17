# syntax=docker/dockerfile:1.7
# apps/diff-worker — BullMQ consumer for diff jobs.
# Three-stage build mirroring apps/api/Dockerfile.
#
# Runtime: distroless nodejs22-debian12. The worker depends on `sharp`
# (native bindings) — sharp ships prebuilt binaries for linux/glibc,
# so distroless-debian12 is the right base (NOT alpine/musl).
#
# Build context = repo root.

#####################################################################
# Stage 1: deps                                                      #
#####################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/diff-worker/package.json apps/diff-worker/

COPY packages/config/package.json         packages/config/
COPY packages/db/package.json             packages/db/
COPY packages/diff-engine/package.json    packages/diff-engine/
COPY packages/eslint-config/package.json  packages/eslint-config/
COPY packages/queue/package.json          packages/queue/
COPY packages/shared-types/package.json   packages/shared-types/
COPY packages/storage/package.json        packages/storage/
COPY packages/telemetry/package.json      packages/telemetry/
COPY packages/tsconfig/package.json       packages/tsconfig/

# `--ignore-scripts`: skip root `prepare` (lefthook needs git) +
# msgpackr-extract node-gyp rebuild. sharp downloads prebuilt binaries
# during its own install script; that runs separately in the runtime
# stage via `pnpm rebuild sharp` if needed (here sharp's prebuilt grabs
# at install-time work fine on bookworm-slim, but with --ignore-scripts
# we skip them. We restore native bindings in the build stage's full
# install below.)
RUN pnpm install --frozen-lockfile --filter @furan/diff-worker... --ignore-scripts

#####################################################################
# Stage 2: build                                                     #
#####################################################################
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/diff-worker/ apps/diff-worker/

# Re-run install WITHOUT --ignore-scripts so sharp's postinstall
# downloads its prebuilt binary into node_modules/.pnpm/sharp@*. The
# `--prefer-offline` keeps everything cache-resident.
RUN pnpm install --frozen-lockfile --filter @furan/diff-worker... --prefer-offline \
  || pnpm rebuild sharp

RUN pnpm --filter @furan/diff-worker... build

#####################################################################
# Stage 3: runtime — distroless                                      #
#####################################################################
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=nonroot:nonroot /app/node_modules              ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/packages                  ./packages
COPY --from=build --chown=nonroot:nonroot /app/apps/diff-worker/dist     ./apps/diff-worker/dist
COPY --from=build --chown=nonroot:nonroot /app/apps/diff-worker/package.json ./apps/diff-worker/package.json
COPY --from=build --chown=nonroot:nonroot /app/package.json              ./package.json
COPY --from=build --chown=nonroot:nonroot /app/pnpm-workspace.yaml       ./pnpm-workspace.yaml

USER nonroot
EXPOSE 3200

# Worker exposes a node:http health server on PORT (default 3200).
# See apps/diff-worker/src/health.ts: /livez, /healthz, /readyz, /metrics.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3200/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["apps/diff-worker/dist/server.js"]
