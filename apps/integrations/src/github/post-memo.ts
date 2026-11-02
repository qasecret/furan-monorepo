/**
 * What the service last posted to GitHub for a key, so an identical post is not
 * repeated. GitHub keeps every commit status that is posted and allows at most
 * 1000 per commit and context, and a review re-reports runs whose status did
 * not move, so the commit status is only posted when its content changed.
 *
 * In memory and bounded (least recently used goes first). A restart, or a
 * second instance, simply forgets: the next post goes out once more, which is
 * harmless because the status is an upsert.
 */
export interface PostMemo {
  /** True when `value` is what was last remembered for `key`. */
  unchanged(key: string, value: string): boolean;
  /** Record `value` as posted for `key`; call it once the post succeeded. */
  remember(key: string, value: string): void;
}

export function createPostMemo(maxEntries = 2000): PostMemo {
  // A Map iterates in insertion order, so re-inserting a key on use keeps the
  // least recently used one first.
  const entries = new Map<string, string>();
  return {
    unchanged(key, value) {
      const last = entries.get(key);
      if (last !== value) return false;
      entries.delete(key);
      entries.set(key, last);
      return true;
    },
    remember(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
  };
}
