import { getSecret } from "@furan/config";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema/index.js";

export type DB = PostgresJsDatabase<typeof schema>;

/**
 * Single connection-pool factory. Apps call this once at startup.
 * Reads `DATABASE_URL` via @furan/config — fails closed if unset.
 */
export function createDb(): { db: DB; close: () => Promise<void> } {
  const url = getSecret("DATABASE_URL");
  const queryClient = postgres(url, { max: 10 });
  const db = drizzle(queryClient, { schema });
  return {
    db,
    close: async () => {
      await queryClient.end();
    },
  };
}
