import { getSecret } from "@furan/config";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema/index.js";

export type DB = PostgresJsDatabase<typeof schema>;

/** Cap any single statement at 30s server-side so one slow query / lock wait
 *  can't pin a pooled connection indefinitely and starve the pool (which,
 *  paired with no HTTP timeout, cascades into service-wide unavailability). */
const STATEMENT_TIMEOUT_MS = 30_000;
/** Fail a connection attempt fast rather than hanging on an unreachable DB. */
const CONNECT_TIMEOUT_SEC = 10;
/** Reap a pooled connection after 10 min idle so a service that goes quiet
 *  releases its phantom connections back to Postgres instead of pinning up to
 *  `max` sockets for the process lifetime. Gentle enough that a busy service
 *  (conns reused well within 10 min) never churns. */
const IDLE_TIMEOUT_SEC = 600;
/** Recycle a connection after 30 min regardless of use, so a long-lived worker
 *  can't accumulate server-side memory on a single ancient session and picks up
 *  server-side changes (e.g. a failover) within bounded time. */
const MAX_LIFETIME_SEC = 1800;

/**
 * Single connection-pool factory. Apps call this once at startup.
 * Reads `DATABASE_URL` via @furan/config — fails closed if unset.
 */
export function createDb(opts?: {
  /** Override the connection string (ADR-058: the API passes the `furan_app`
   *  URL so RLS applies). Defaults to the `DATABASE_URL` secret. */
  url?: string;
}): { db: DB; close: () => Promise<void> } {
  const url = opts?.url ?? getSecret("DATABASE_URL");
  const queryClient = postgres(url, {
    max: 10,
    connect_timeout: CONNECT_TIMEOUT_SEC,
    idle_timeout: IDLE_TIMEOUT_SEC,
    max_lifetime: MAX_LIFETIME_SEC,
    // Server-side per-statement ceiling — applied as a startup parameter on
    // every pooled connection, so it survives reconnects and covers raw SQL,
    // Drizzle queries, and transactions alike.
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
  });
  const db = drizzle(queryClient, { schema });
  return {
    db,
    close: async () => {
      await queryClient.end();
    },
  };
}
