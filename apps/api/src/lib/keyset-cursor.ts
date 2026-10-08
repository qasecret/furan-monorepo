import { sql } from "@furan/db";
import { z } from "zod";

/**
 * Opaque `(timestamp, id)` keyset cursor shared by the newest-first list
 * endpoints. `createdAt` is the `cursorTimestamp` text of the column the list
 * orders by (`applied_at` for auto-rule applications); `id` breaks ties, so
 * rows sharing a timestamp (e.g. one transaction's now()) aren't skipped.
 */
const keysetCursor = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});
export type KeysetCursor = z.infer<typeof keysetCursor>;

/**
 * A timestamptz as ISO-8601 UTC text at full (microsecond) precision.
 *
 * Postgres stores µs; a JS Date holds only ms. A cursor built from
 * `Date#toISOString()` is truncated, so rows sharing the last row's
 * millisecond at a later µs compare as newer than the cursor and the next
 * page silently skips them. This text casts back with `::timestamptz` to
 * exactly the stored value, and keeps the keyset on the raw column so its
 * index still serves the ORDER BY.
 *
 * `column` is a timestamptz column or SQL expression.
 */
export function cursorTimestamp(column: unknown) {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Null for a malformed cursor (callers restart from the top), so a bad value
 * never reaches a `::timestamptz` / `::uuid` cast and 500s.
 */
export function decodeKeysetCursor(raw: string): KeysetCursor | null {
  try {
    const parsed = keysetCursor.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
