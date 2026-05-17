# syntax=docker/dockerfile:1.7
# apps/integrations — Fastify webhook receiver + Redis Pub/Sub subscriber.
# Three-stage build mirroring apps/api/Dockerfile.
#
# Build context = repo root.

#####################################################################
# Stage 1: deps                                                      #
#####################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/integrations/package.json apps/integrations/

COPY packages/config/package.json         packages/config/
COPY packages/db/package.json             packages/db/
COPY packages/diff-engine/package.json    packages/diff-engine/
COPY packages/eslint-config/package.json  packages/eslint-config/
COPY packages/queue/package.json          packages/queue/
COPY packages/shared-types/package.json   packages/shared-types/
COPY packages/storage/package.json        packages/storage/
COPY packages/telemetry/package.json      packages/telemetry/
COPY packages/tsconfig/package.json       packages/tsconfig/

RUN pnpm install --frozen-lockfile --filter @furan/integrations... --ignore-scripts

#####################################################################
# Stage 2: build                                                     #
#####################################################################
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/integrations/ apps/integrations/

RUN pnpm --filter @furan/integrations... build

#####################################################################
# Stage 3: runtime — distroless, non-root                            #
#####################################################################
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=nonroot:nonroot /app/node_modules               ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/packages                   ./packages
COPY --from=build --chown=nonroot:nonroot /app/apps/integrations/dist     ./apps/integrations/dist
COPY --from=build --chown=nonroot:nonroot /app/apps/integrations/package.json ./apps/integrations/package.json
COPY --from=build --chown=nonroot:nonroot /app/package.json               ./package.json
COPY --from=build --chown=nonroot:nonroot /app/pnpm-workspace.yaml        ./pnpm-workspace.yaml

USER nonroot
# 3400 = Fastify webhook receiver, 3300 = node:http health server
# (see apps/integrations/src/env.ts: INTEGRATIONS_PORT, HEALTH_PORT).
EXPOSE 3400 3300

# Liveness probes the dedicated health port (3300) — see apps/integrations/src/health.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3300/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["apps/integrations/dist/server.js"]
