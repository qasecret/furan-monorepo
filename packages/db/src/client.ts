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

/**
 * Single connection-pool factory. Apps call this once at startup.
 * Reads `DATABASE_URL` via @furan/config — fails closed if unset.
 */
export function createDb(): { db: DB; close: () => Promise<void> } {
  const url = getSecret("DATABASE_URL");
  const queryClient = postgres(url, {
    max: 10,
    connect_timeout: CONNECT_TIMEOUT_SEC,
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
