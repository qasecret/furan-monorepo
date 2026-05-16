import { eq, tokens, users, type DB } from "@furan/db";
import type { Telemetry } from "@furan/telemetry";
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { Env } from "./env.js";
import { hashToken, isPatFormat } from "./lib/token.js";
import authPlugin from "./plugins/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBuildsRoutes } from "./routes/builds.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMembersRoutes } from "./routes/members.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerRunEventsRoute } from "./routes/run-events.js";
import { registerTokensRoutes } from "./routes/tokens.js";
import { registerUsersAdminRoutes } from "./routes/users-admin.js";
import { registerUsersRoutes } from "./routes/users.js";
import { buildContext } from "./trpc/context.js";
import { appRouter } from "./trpc/v1/router.js";

export interface AppDeps {
  db: DB;
  telemetry: Telemetry;
  env: Env;
}

declare module "fastify" {
  interface FastifyInstance {
    db: DB;
    telemetry: Telemetry;
    env: Env;
  }
}

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.telemetry.logger as unknown as FastifyBaseLogger,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: "x-request-id",
    disableRequestLogging: false,
  });

  app.decorate("db", deps.db);
  app.decorate("telemetry", deps.telemetry);
  app.decorate("env", deps.env);

  // Plugins + routes register in Tasks 2-7.
  await app.register(authPlugin);
  await registerAuthRoutes(app);
  await registerTokensRoutes(app);
  await registerUsersRoutes(app);
  await registerUsersAdminRoutes(app);
  await registerProjectsRoutes(app);
  await registerMembersRoutes(app);
  await registerBuildsRoutes(app);
  await registerRunEventsRoute(app);
  await registerHealthRoutes(app);

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
        buildContext(req, { db: deps.db, telemetry: deps.telemetry }),
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
    const legacy = req.headers["apikey"];
    if (typeof legacy === "string") raw = legacy;
  }
  if (!raw) return;

  if (isPatFormat(raw)) {
    const hash = hashToken(raw);
    const rows = await app.db
      .select({
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
    }
    return;
  }

  try {
    await req.jwtVerify();
    const payload = req.user;
    req.auth = { id: payload.sub, role: payload.role };
  } catch {
    // leave req.auth null
  }
}
