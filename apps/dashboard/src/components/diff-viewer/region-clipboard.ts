import { useSyncExternalStore } from "react";

import type { IgnoreArea } from "./useViewerStore";

const VERSION = 1;
const KEY_PREFIX = "furan:region-clipboard:";

/**
 * Wire shape persisted in sessionStorage. Versioned so future schema
 * changes can ignore stale entries instead of crashing on parse.
 */
interface ClipboardEntry {
  _v: typeof VERSION;
  region: Omit<IgnoreArea, "id">;
  copiedAt: number;
}

function keyFor(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

export function setClipboardRegion(
  projectId: string,
  region: IgnoreArea,
): void {
  if (typeof window === "undefined") return;
  const { id: _drop, ...rest } = region;
  void _drop;
  const entry: ClipboardEntry = {
    _v: VERSION,
    region: rest,
    copiedAt: Date.now(),
  };
  sessionStorage.setItem(keyFor(projectId), JSON.stringify(entry));
  // Native `storage` event excludes the originating tab, so we fire a
  // custom event for same-tab Copy → Paste flows. Cross-tab still works
  // via the storage listener in useClipboardRegion.
  window.dispatchEvent(
    new CustomEvent("furan:clipboard-changed", { detail: { projectId } }),
  );
}

export function getClipboardRegion(
  projectId: string,
): Omit<IgnoreArea, "id"> | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(keyFor(projectId));
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as ClipboardEntry;
    if (entry._v !== VERSION) return null;
    return entry.region;
  } catch {
    return null;
  }
}

export function clearClipboardRegion(projectId: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(keyFor(projectId));
  window.dispatchEvent(
    new CustomEvent("furan:clipboard-changed", { detail: { projectId } }),
  );
}

/**
 * Per-project snapshot cache. `useSyncExternalStore` requires
 * `getSnapshot` to return a stable reference when underlying state is
 * unchanged — but `getClipboardRegion` deserializes JSON on every call
 * (fresh object reference), which would trigger React's "getSnapshot
 * should be cached" infinite-render guard. We cache by raw sessionStorage
 * string so the cache invalidates exactly when the underlying data
 * changes, and use a sentinel-empty value (null) when there's nothing.
 */
const snapshotCache = new Map<
  string,
  { raw: string | null; value: Omit<IgnoreArea, "id"> | null }
>();

function cachedSnapshot(projectId: string): Omit<IgnoreArea, "id"> | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(keyFor(projectId));
  const cached = snapshotCache.get(projectId);
  if (cached && cached.raw === raw) return cached.value;
  const value = getClipboardRegion(projectId);
  snapshotCache.set(projectId, { raw, value });
  return value;
}

/**
 * React hook: returns the current clipboard entry for the project,
 * re-renders the component when the clipboard changes (same tab via
 * the custom event; other tabs via the native `storage` event).
 */
export function useClipboardRegion(
  projectId: string,
): Omit<IgnoreArea, "id"> | null {
  return useSyncExternalStore(
    (cb) => {
      const onCustom = (e: Event) => {
        const ce = e as CustomEvent<{ projectId: string }>;
        if (ce.detail?.projectId === projectId) cb();
      };
      const onStorage = (e: StorageEvent) => {
        if (e.key === keyFor(projectId)) cb();
      };
      window.addEventListener("furan:clipboard-changed", onCustom);
      window.addEventListener("storage", onStorage);
      return () => {
        window.removeEventListener("furan:clipboard-changed", onCustom);
        window.removeEventListener("storage", onStorage);
      };
    },
    () => cachedSnapshot(projectId),
    () => null, // SSR snapshot
  );
}
