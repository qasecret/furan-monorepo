import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { eq, tokens, users, type DB } from "@furan/db";
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
import { hashToken, isPatFormat } from "./lib/token.js";
import { touchTokenLastUsed } from "./lib/touch-token.js";
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
}

declare module "fastify" {
  interface FastifyInstance {
    db: DB;
    telemetry: Telemetry;
    env: Env;
    diffQueue: DiffQueueProducer;
    broadcaster: Broadcaster;
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
      if (status >= 500) {
        return reply.code(status).send({ error: "internal_error" });
      }
      return reply.code(status).send({
        statusCode: status,
        error: err.name || "Error",
        message: err.message,
      });
    },
  );

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
    const hash = hashToken(raw);
    const rows = await app.db
      .select({
        tokenId: tokens.id,
        userId: tokens.userId,
        role: users.role,
        isActive: users.isActive,
      })
      .from(tokens)
      .innerJoin(users, eq(users.id, tokens.userId))
      .where(eq(tokens.hash, hash))
      .limit(1);
    const row = rows[0];
    if (row && row.isActive) {
      req.auth = { id: row.userId, role: row.role };
      await touchTokenLastUsed(app.db, row.tokenId);
    }
    return;
  }

  try {
    // Verify the extracted token (Bearer header *or* furan_jwt cookie);
    // see plugins/auth.ts for the same pattern.
    const payload = app.jwt.verify(raw) as {
      sub: string;
      role: "admin" | "editor" | "guest";
    };
    req.auth = { id: payload.sub, role: payload.role };
  } catch {
    // leave req.auth null
  }
}
