import type { DB } from "@furan/db";
import type { DiffJob } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";
import type { FastifyRequest } from "fastify";

import type { AuthedUser } from "../plugins/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthedUser | null;
  }
}

/**
 * Narrow producer interface for the diff queue. Defined here (not pulled
 * from bullmq) so tests can inject a vi.fn() without satisfying the full
 * Queue surface. Production wires a real `createQueue("diff")` in
 * server.ts; tests pass `{ add: vi.fn() }`.
 */
export interface DiffQueueProducer {
  add(name: "diff", data: DiffJob): Promise<unknown>;
}

export interface BuildContextDeps {
  db: DB;
  telemetry: Telemetry;
  diffQueue: DiffQueueProducer;
}

export function buildContext(req: FastifyRequest, deps: BuildContextDeps) {
  return {
    user: req.auth ?? null,
    db: deps.db,
    telemetry: deps.telemetry,
    diffQueue: deps.diffQueue,
    req,
  };
}

export type Context = ReturnType<typeof buildContext>;
