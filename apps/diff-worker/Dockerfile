# syntax=docker/dockerfile:1.7
# apps/diff-worker — BullMQ consumer for diff jobs.
# Four-stage build mirroring apps/api/Dockerfile.
#
# Runtime: distroless nodejs22-debian13. The worker depends on `sharp`
# (native bindings) — sharp ships prebuilt binaries for linux/glibc,
# so a distroless-debian base is the right base (NOT alpine/musl).
#
# Bumped from debian12 → debian13 because odiff-bin's aarch64 binary is
# linked against GLIBC_2.38, which is too new for debian12 (glibc 2.36).
# On Apple Silicon (and any ARM64 host) odiff would spawn-fail silently
# and the diff worker would land every job in `aborted` with no log. We
# saw this in the wild; debian13 ships glibc 2.41 which satisfies it.
# (debian12 is fine on amd64 — odiff's x86_64 binary is statically OK —
# but maintaining two bases for one issue isn't worth it.)
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
# Stage 3: prune — prod-only deps (Phase 5 D6(e))                    #
#####################################################################
# Fresh install from the lockfile with --prod so devDeps (tsc, eslint,
# vitest, tsx, @types/*, etc.) never enter node_modules. Runtime copies
# node_modules from here instead of from `build`, shrinking the
# distroless image substantially.
#
# We start from a clean /app and copy only manifests + lockfile (NOT
# build's node_modules). Running `pnpm install --prod` on top of an
# existing devDep-bearing tree keeps the extras — pnpm's `--prod` does
# NOT retroactively prune. A clean install side-steps that.
#
# We omit --ignore-scripts so sharp's postinstall fetches its prebuilt
# binary into the new node_modules tree.
FROM node:22-bookworm-slim AS prune
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

RUN pnpm install --frozen-lockfile --filter @furan/diff-worker... --prod --prefer-offline \
  || pnpm rebuild sharp

#####################################################################
# Stage 4: runtime — distroless                                      #
#####################################################################
FROM gcr.io/distroless/nodejs22-debian13:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production

# pnpm's isolated node-linker places per-package symlinks under
# apps/<name>/node_modules — Node's ESM resolver walks UP from the entry
# point, so apps/diff-worker/node_modules/@furan/config is required, not
# just /app/node_modules/@furan/config. Both come from the `prune` stage
# so devDeps stay out of the runtime image.
COPY --from=prune --chown=nonroot:nonroot /app/node_modules                  ./node_modules
COPY --from=prune --chown=nonroot:nonroot /app/apps/diff-worker/node_modules ./apps/diff-worker/node_modules
COPY --from=build --chown=nonroot:nonroot /app/packages                      ./packages
COPY --from=build --chown=nonroot:nonroot /app/apps/diff-worker/dist         ./apps/diff-worker/dist
COPY --from=build --chown=nonroot:nonroot /app/apps/diff-worker/package.json ./apps/diff-worker/package.json
COPY --from=build --chown=nonroot:nonroot /app/package.json                  ./package.json
COPY --from=build --chown=nonroot:nonroot /app/pnpm-workspace.yaml           ./pnpm-workspace.yaml

USER nonroot
EXPOSE 3200

# Worker exposes a node:http health server on PORT (default 3200).
# See apps/diff-worker/src/health.ts: /livez, /healthz, /readyz, /metrics.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3200/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["apps/diff-worker/dist/server.js"]
