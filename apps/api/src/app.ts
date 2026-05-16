import type { DB } from "@furan/db";
import type { Telemetry } from "@furan/telemetry";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

import type { Env } from "./env.js";
import authPlugin from "./plugins/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTokensRoutes } from "./routes/tokens.js";
import { registerUsersRoutes } from "./routes/users.js";

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
  await registerHealthRoutes(app);

  return app;
}
