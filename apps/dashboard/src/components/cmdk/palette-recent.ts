/**
 * The palette's Recent group (spec §5.2): the pages a user last went to from
 * the palette, newest first, at most five, kept in this browser per user id
 * (`furan:palette:recent:<userId>`), so one person's list never shows for
 * another who signs in here.
 */

/**
 * A page the palette went to. One of the palette's own pages is kept by its
 * id alone ("go.settings", "project:<id>"), and the palette works out where it
 * is when it lists it again, so Settings follows the current project. A page
 * that is not one of those also keeps its address (`href`).
 */
export interface RecentEntry {
  id: string;
  label: string;
  href?: string;
}

export const RECENT_LIMIT = 5;

/** The un-keyed list an earlier palette kept for every user of a browser. */
const LEGACY_KEY = "furan:recent-projects";

export function recentKey(userId: string): string {
  return `furan:palette:recent:${userId}`;
}

/** A page of this app: a path, not a scheme ("javascript:") or another host. */
export function isAppPath(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function isEntry(value: unknown): value is RecentEntry {
  if (value === null || typeof value !== "object") return false;
  const { id, label, href } = value as Partial<RecentEntry>;
  return (
    typeof id === "string" &&
    id !== "" &&
    typeof label === "string" &&
    (href === undefined || (typeof href === "string" && isAppPath(href)))
  );
}

/** Only the fields an entry has, so a stored value carries nothing else. */
function clean({ id, label, href }: RecentEntry): RecentEntry {
  return href === undefined ? { id, label } : { id, label, href };
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
    return parsed.filter(isEntry).map(clean).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Puts `entry` first in `userId`'s Recent, once (by id), keeping the newest
 * five. Nothing is kept without a user id or when storage is blocked.
 */
export function recordRecent(userId: string, entry: RecentEntry): void {
  if (!userId || !isEntry(entry)) return;
  try {
    const next = [
      clean(entry),
      ...readRecent(userId).filter((e) => e.id !== entry.id),
    ].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(recentKey(userId), JSON.stringify(next));
  } catch {
    // Not kept; the palette works the same.
  }
}

/**
 * Removes the un-keyed recent-projects list an earlier palette kept, which
 * showed one user's projects to the next on a shared browser.
 */
export function forgetLegacyRecent(): void {
  try {
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Blocked storage: nothing to remove that can be read either.
  }
}
