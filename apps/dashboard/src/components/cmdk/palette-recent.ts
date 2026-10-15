/**
 * The palette's Recent group (spec §5.2): the pages a user last went to from
 * the palette, newest first, at most five, kept in this browser per user id
 * (`furan:palette:recent:<userId>`), so one person's list never shows for
 * another who signs in here. The old un-keyed list is not read.
 */

/** A page the palette went to, as Recent lists it again. */
export interface RecentEntry {
  label: string;
  href: string;
}

export const RECENT_LIMIT = 5;

export function recentKey(userId: string): string {
  return `furan:palette:recent:${userId}`;
}

/** A page of this app: a path, not a scheme ("javascript:") or another host. */
function isAppPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function isEntry(value: unknown): value is RecentEntry {
  if (value === null || typeof value !== "object") return false;
  const { label, href } = value as Partial<RecentEntry>;
  return (
    typeof label === "string" && typeof href === "string" && isAppPath(href)
  );
}

/**
 * `userId`'s Recent, newest first. Empty with no user id, nothing stored,
 * storage blocked (privacy modes) or a value that isn't a list of entries.
 */
export function readRecent(userId: string): RecentEntry[] {
  if (!userId) return [];
  try {
    const raw = window.localStorage.getItem(recentKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .map(({ label, href }) => ({ label, href }))
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Puts `entry` first in `userId`'s Recent, once (by `href`), keeping the
 * newest five. Nothing is kept without a user id or when storage is blocked.
 */
export function recordRecent(userId: string, entry: RecentEntry): void {
  if (!userId || !isAppPath(entry.href)) return;
  try {
    const next = [
      { label: entry.label, href: entry.href },
      ...readRecent(userId).filter((e) => e.href !== entry.href),
    ].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(recentKey(userId), JSON.stringify(next));
  } catch {
    // Not kept; the palette works the same.
  }
}
