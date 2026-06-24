import { sql, tokens, type DB } from "@furan/db";

/**
 * Record that a personal access token was just used.
 *
 * Throttled at the row level: `last_used_at` is only rewritten when it is
 * null or older than the window below, so the hot auth path performs at most
 * one write per token per minute (the UPDATE still runs, but matches zero
 * rows when the stamp is fresh).
 *
 * Best-effort: a failure here must never break an otherwise-valid
 * authentication, so all errors are swallowed.
 */
export async function touchTokenLastUsed(
  db: DB,
  tokenId: string,
): Promise<void> {
  try {
    await db
      .update(tokens)
      .set({ lastUsedAt: sql`now()` })
      .where(
        sql`${tokens.id} = ${tokenId} and (${tokens.lastUsedAt} is null or ${tokens.lastUsedAt} < now() - interval '60 seconds')`,
      );
  } catch {
    // best-effort — usage tracking must not fail auth
  }
}
