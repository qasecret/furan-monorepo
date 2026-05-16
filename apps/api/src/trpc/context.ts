import type { DB } from "@furan/db";
import type { Telemetry } from "@furan/telemetry";
import type { FastifyRequest } from "fastify";

import type { AuthedUser } from "../plugins/auth.js";

// `req.auth` is added by plugins/auth.ts via a Fastify module
// augmentation. We re-declare it locally so downstream consumers that
// resolve `@furan/api/trpc` types in isolation (e.g. apps/dashboard's
// Next.js compile) don't trip on a missing augmentation.
declare module "fastify" {
  interface FastifyRequest {
    auth: AuthedUser | null;
  }
}

export interface BuildContextDeps {
  db: DB;
  telemetry: Telemetry;
}

/**
 * Builds the tRPC request context. `req.auth` is populated by the
 * `/trpc/*` onRequest authenticate hook registered in `app.ts` BEFORE
 * tRPC enters its middleware chain (spec §7 P2-R6).
 */
export function buildContext(req: FastifyRequest, deps: BuildContextDeps) {
  return {
    user: req.auth ?? null,
    db: deps.db,
    telemetry: deps.telemetry,
    req,
  };
}

export type Context = ReturnType<typeof buildContext>;
