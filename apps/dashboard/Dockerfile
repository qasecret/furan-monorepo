# syntax=docker/dockerfile:1.7
# apps/dashboard — Next.js 15 (App Router) with standalone output.
# Three-stage build, distroless runtime, non-root.
#
# Build context = repo root. The standalone output (.next/standalone)
# pulls only the files Next traces — significantly smaller than a full
# node_modules copy.

#####################################################################
# Stage 1: deps                                                      #
#####################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
# Dashboard depends on @furan/api (for the tRPC AppRouter type) which
# transitively pulls in every workspace package. Bring them all in.
COPY apps/api/package.json        apps/api/

COPY packages/config/package.json         packages/config/
COPY packages/db/package.json             packages/db/
COPY packages/diff-engine/package.json    packages/diff-engine/
COPY packages/eslint-config/package.json  packages/eslint-config/
COPY packages/queue/package.json          packages/queue/
COPY packages/shared-types/package.json   packages/shared-types/
COPY packages/storage/package.json        packages/storage/
COPY packages/telemetry/package.json      packages/telemetry/
COPY packages/tsconfig/package.json       packages/tsconfig/

RUN pnpm install --frozen-lockfile --filter @furan/dashboard... --ignore-scripts

#####################################################################
# Stage 2: build                                                     #
#####################################################################
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages/ packages/
# The dashboard imports types from @furan/api (`./trpc`), so the api app
# needs to be present + compiled for the type-only import to resolve.
COPY apps/api/        apps/api/
COPY apps/dashboard/  apps/dashboard/

# Build @furan/api first so dashboard's `import type { AppRouter }` from
# @furan/api/trpc has the compiled .d.ts to consume, then Next build.
RUN pnpm --filter @furan/api... build \
 && pnpm --filter @furan/dashboard build

#####################################################################
# Stage 3: runtime — distroless                                      #
#####################################################################
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

# Next standalone output layout (with outputFileTracingRoot=../../):
#   /app/apps/dashboard/.next/standalone/                 <- pnpm workspace root
#     ├─ apps/dashboard/server.js                          <- entry point
#     ├─ apps/dashboard/.next/                             <- server runtime
#     ├─ node_modules/                                     <- traced deps only
#     ├─ packages/...                                      <- traced workspace pkgs
#     └─ package.json
#
# Static assets (.next/static) and the public/ dir are NOT included in
# standalone — they must be layered in separately.
COPY --from=build --chown=nonroot:nonroot /app/apps/dashboard/.next/standalone/      ./
COPY --from=build --chown=nonroot:nonroot /app/apps/dashboard/.next/static           ./apps/dashboard/.next/static

USER nonroot
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3001/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["apps/dashboard/server.js"]
