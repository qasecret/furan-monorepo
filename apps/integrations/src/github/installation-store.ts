import { eq, installations, type DB } from "@furan/db";

/**
 * Thin CRUD wrapper over the `installations` table.
 *
 * Called from the GitHub App webhook handlers (`installation.created`,
 * `installation.deleted`, `installation_repositories.{added,removed}`).
 *
 * `installations.installationId` carries a UNIQUE index, so the upsert
 * uses `ON CONFLICT (installation_id) DO UPDATE`.
 */
export async function upsertInstallation(
  db: DB,
  opts: {
    installationId: number;
    accountLogin: string;
    repositoryIds: number[];
  },
): Promise<void> {
  await db
    .insert(installations)
    .values({
      installationId: opts.installationId,
      accountLogin: opts.accountLogin,
      repositoryIds: opts.repositoryIds,
    })
    .onConflictDoUpdate({
      target: installations.installationId,
      set: {
        accountLogin: opts.accountLogin,
        repositoryIds: opts.repositoryIds,
        updatedAt: new Date(),
      },
    });
}

export async function getInstallation(
  db: DB,
  installationId: number,
): Promise<typeof installations.$inferSelect | null> {
  const rows = await db
    .select()
    .from(installations)
    .where(eq(installations.installationId, installationId))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteInstallation(
  db: DB,
  installationId: number,
): Promise<void> {
  await db
    .delete(installations)
    .where(eq(installations.installationId, installationId));
}
