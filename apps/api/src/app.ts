import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { type DB } from "@furan/db";
import type { Telemetry } from "@furan/telemetry";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { Env } from "./env.js";
import type { Broadcaster } from "./lib/broadcast.js";
import { sendError } from "./lib/errors.js";
import { loadActiveUserByPat } from "./lib/load-active-user.js";
import type { MemberProjectsCache } from "./lib/member-projects-cache.js";
import { resolveAuthUser } from "./lib/resolve-auth-user.js";
import { isPatFormat } from "./lib/token.js";
import { touchTokenLastUsed } from "./lib/touch-token.js";
import type { UserAuthCache } from "./lib/user-auth-cache.js";
import docsPlugin from "./openapi/docs-plugin.js";
import authPlugin from "./plugins/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBuildsRoutes } from "./routes/builds.js";
import { registerDashboardTelemetryRoutes } from "./routes/dashboard-telemetry.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMembersRoutes } from "./routes/members.js";
import { registerProjectEventsRoute } from "./routes/project-events.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerRunEventsRoute } from "./routes/run-events.js";
import { registerRunLifecycleRoutes } from "./routes/runs-lifecycle.js";
import { registerSdkRoutes } from "./routes/sdk-runs.js";
import { registerStorageProxyRoute } from "./routes/storage-proxy.js";
import { registerTokensRoutes } from "./routes/tokens.js";
import { registerUsersAdminRoutes } from "./routes/users-admin.js";
import { registerUsersRoutes } from "./routes/users.js";
import { buildContext, type DiffQueueProducer } from "./trpc/context.js";
import { appRouter } from "./trpc/v1/router.js";

export interface AppDeps {
  db: DB;
  telemetry: Telemetry;
  env: Env;
  diffQueue: DiffQueueProducer;
  broadcaster: Broadcaster;
  /** Optional cache for the per-request JWT user lookup. Absent → direct DB read. */
  cache?: UserAuthCache;
  /** Optional cache for a user's member-project set (storage-proxy hot path). */
  memberProjectsCache?: MemberProjectsCache;
}

declare module "fastify" {
  interface FastifyInstance {
    db: DB;
    telemetry: Telemetry;
    env: Env;
    diffQueue: DiffQueueProducer;
    broadcaster: Broadcaster;
    cache: UserAuthCache | null;
    memberProjectsCache: MemberProjectsCache | null;
  }
}

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  // Fastify's default bodyLimit is 1 MB, which is fine for JSON RPCs but
  // trips the outer content-type-parser before @fastify/multipart can run
  // its per-file fileSize check (50 MB, set below). The screenshots route
  // tolerates an oversized `elementMapJson` part by dropping it silently
  // — that contract is unreachable when the whole multipart envelope is
  // rejected with 413 first. Lift the bodyLimit to match the multipart
  // file ceiling so the route owns the truncation behaviour, not Fastify.
  const app = Fastify({
    loggerInstance: deps.telemetry.logger as unknown as FastifyBaseLogger,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: "x-request-id",
    disableRequestLogging: false,
    bodyLimit: 50 * 1024 * 1024,
    // Bound the time allowed to *receive* a full request (headers + body) so a
    // slow-loris client can't hold a connection open forever. This governs
    // request receipt, NOT handler/response duration, so the long-lived SSE
    // endpoints (/api/v1/**/events) keep streaming unaffected.
    requestTimeout: 120_000,
    // tRPC's httpBatchLink encodes the batched procedure list into the URL
    // PATH (e.g. /trpc/a.b,c.d,e.f). Fastify caps a single route param at
    // `maxParamLength` (default 100) and 404s "Route ... not found" past it —
    // so a batch of ~6 procedures (here 101 chars) silently fails the whole
    // request, which react-query then retries into a loop. 5000 is the tRPC
    // docs' recommended ceiling and leaves ample headroom.
    maxParamLength: 5000,
  });

  app.decorate("db", deps.db);
  app.decorate("telemetry", deps.telemetry);
  app.decorate("env", deps.env);
  app.decorate("diffQueue", deps.diffQueue);
  app.decorate("broadcaster", deps.broadcaster);
  app.decorate("cache", deps.cache ?? null);
  app.decorate("memberProjectsCache", deps.memberProjectsCache ?? null);

  // Generic 5xx body so internal failures don't leak SQL, query params, or
  // stack frames to the client. Fastify's default error handler returns
  // `err.message` verbatim, which for a Drizzle/Postgres exception is the
  // full SQL + bind params — a sensitive info leak we don't want any route
  // to accidentally surface (caught in the wild on POST /projects/:id/builds
  // when an SDK client targets a deleted project). 4xx pass through so
  // input-validation messages (Zod, etc.) still reach the client; the full
  // error always lands in the structured log with reqId for correlation.
  app.setErrorHandler(
    (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
      const status =
        err.statusCode && err.statusCode >= 400 && err.statusCode < 600
          ? err.statusCode
          : 500;
      req.log.error({ err, reqId: req.id, url: req.url }, "request_error");
      // Emit the canonical ApiErrorEnvelope. 5xx is scrubbed to a generic
      // code/message (never leak SQL / stack frames); 4xx keeps the thrown
      // error's code + message so validation detail still reaches the client.
      if (status >= 500) {
        return sendError(reply, status, "internal_error", "Internal error");
      }
      return sendError(
        reply,
        status,
        err.code || err.name || "error",
        err.message,
      );
    },
  );

  // Baseline security headers (nosniff, frameguard, referrer-policy, HSTS,
  // etc.). CSP is disabled: this service is a JSON API, and the one HTML
  // surface — the Scalar API-reference docs page — loads assets a strict
  // default CSP would block. The high-value headers above still apply.
  await app.register(helmet, { contentSecurityPolicy: false });

  // Rate limiting in opt-in mode (`global: false`): SDK uploads and tRPC
  // batches are intentionally NOT throttled here — only routes that set
  // `config.rateLimit` are (currently /auth/login, as a brute-force /
  // credential-stuffing brake). The default store is in-memory (per instance);
  // a multi-instance deployment should pass a Redis store + enable trustProxy
  // so the client IP is the real caller, not the reverse proxy.
  await app.register(rateLimit, {
    global: false,
    // Keep the 429 body in the canonical ApiErrorEnvelope shape.
    errorResponseBuilder: (_req, context) => ({
      code: "rate_limited",
      message: `Rate limit exceeded, retry after ${Math.ceil(
        context.ttl / 1000,
      )}s`,
      statusCode: 429,
    }),
  });

  // CORS must be registered before routes so the preflight handler is wired
  // for every path (the dashboard is a different origin from the api in the
  // default self-host setup, so cross-origin POSTs with JSON bodies trigger
  // a preflight that 404s without this). `credentials: true` is required
  // because dashboard fetches use `credentials: "include"` to send the JWT
  // cookie — which means the Allow-Origin reply cannot be `*`.
  const allowedOrigins = deps.env.FURAN_DASHBOARD_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  // Plugins + routes register in Tasks 2-7.
  await app.register(authPlugin);
  // Multipart parser for SDK screenshot uploads (Phase 4 Task 4).
  // 50 MB ceiling per file part is enforced both here and in the route handler.
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });
  await registerAuthRoutes(app);
  await registerDashboardTelemetryRoutes(app);
  await registerTokensRoutes(app);
  await registerUsersRoutes(app);
  await registerUsersAdminRoutes(app);
  await registerProjectsRoutes(app);
  await registerMembersRoutes(app);
  await registerBuildsRoutes(app);
  await registerRunEventsRoute(app);
  await registerProjectEventsRoute(app);
  await registerSdkRoutes(app);
  await registerRunLifecycleRoutes(app);
  await registerStorageProxyRoute(app);
  await registerHealthRoutes(app);
  await app.register(docsPlugin);

  // Soft-authenticate /trpc/* requests: populate req.auth when valid creds
  // are present, otherwise leave it null. tRPC middlewares (authed,
  // projectMember) enforce auth/RBAC per-procedure. We cannot call the
  // decorator `app.authenticate` here because it writes 401 directly onto
  // `reply`, which would short-circuit public/unauthenticated procedures.
  // Spec §7 P2-R6: req.auth must be set before tRPC's createContext runs.
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/trpc/") && req.url !== "/trpc") return;
    await softAuthenticate(app, req);
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }) =>
        buildContext(req, {
          db: deps.db,
          telemetry: deps.telemetry,
          diffQueue: deps.diffQueue,
          broadcaster: deps.broadcaster,
        }),
      onError: ({ error, path }) => {
        app.log.error({ path, err: error }, "trpc_error");
      },
    } satisfies FastifyTRPCPluginOptions<typeof appRouter>["trpcOptions"],
  });

  return app;
}

// Best-effort credential resolver used only on /trpc/*. Mirrors the
// recognition logic in plugins/auth.ts but never short-circuits — failures
// leave `req.auth = null` so tRPC's `authed` middleware can decide.
async function softAuthenticate(
  app: FastifyInstance,
  req: import("fastify").FastifyRequest,
): Promise<void> {
  const authz = req.headers["authorization"];
  let raw: string | null = null;
  if (typeof authz === "string") {
    const m = /^Bearer\s+(.+)$/.exec(authz);
    if (m) raw = m[1] ?? null;
  }
  if (!raw) {
    // Dashboard's HttpOnly cookie (same fallback as plugins/auth.ts —
    // see the note there on why browser fetches need this).
    const cookieHeader = req.headers["cookie"];
    if (typeof cookieHeader === "string") {
      const m = /(?:^|;\s*)furan_jwt=([^;]+)/.exec(cookieHeader);
      if (m && m[1]) {
        try {
          raw = decodeURIComponent(m[1]);
        } catch {
          raw = null;
        }
      }
    }
  }
  if (!raw) {
    const legacy = req.headers["apikey"];
    if (typeof legacy === "string") raw = legacy;
  }
  if (!raw) return;

  if (isPatFormat(raw)) {
    const pat = await loadActiveUserByPat(app.db, raw);
    if (pat) {
      req.auth = { id: pat.id, role: pat.role };
      await touchTokenLastUsed(app.db, pat.tokenId);
    }
    return;
  }

  let payload: { sub: string };
  try {
    // Verify the extracted token (Bearer header *or* furan_jwt cookie);
    // see plugins/auth.ts for the same pattern. The role claim is ignored —
    // the live role comes from loadActiveUser below.
    payload = app.jwt.verify(raw) as { sub: string };
  } catch {
    return; // bad signature → leave req.auth null
  }

  // Reflect LIVE role/active state (cache → DB) rather than the stale claim: a
  // demoted user gets their lower role; a deactivated/missing user resolves to
  // null and the per-procedure `authed`/`projectMember` middleware rejects. Soft
  // path, so null just means "not authenticated"; a DB error propagates like the
  // PAT branch above.
  const fresh = await resolveAuthUser(
    { db: app.db, cache: app.cache },
    payload.sub,
  );
  req.auth =
    fresh && fresh.isActive ? { id: payload.sub, role: fresh.role } : null;
}
