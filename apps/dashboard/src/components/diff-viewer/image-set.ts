/**
 * One image loader for the diff viewer.
 *
 * Each storage key is fetched once and decoded once, straight into an
 * `ImageBitmap`. Bitmaps live in one module-level LRU, capped by count and by
 * estimated bytes, so stepping back and forth through a run never refetches or
 * redecodes an image the reviewer has already seen. The steps either side of
 * the current one are prefetched, and work a step change has made stale is
 * aborted.
 *
 * Ownership: the cache owns every bitmap it is handed and is the only code
 * that calls `close()`, and only when it evicts. Consumers read bitmaps and
 * never close them.
 *
 * Pins: a bitmap on screen must never be closed, however tall the screenshots.
 * `useImageSet` pins the keys it was asked to show; eviction skips pinned
 * entries, so the limits bite on everything else (prefetched and past steps).
 *
 * No object URL is made on the way to a bitmap unless the browser refuses the
 * blob twice (see `decodeImage`).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import type { Size } from "./viewer-geometry";

import { browserEnv } from "@/lib/env";

export type ImageRole = "baseline" | "current" | "diff";

/** Storage keys to show; `null` means that role has no image. */
export interface ImageSetRequest {
  baseline: string | null;
  current: string | null;
  diff: string | null;
}

export interface LoadedImage {
  key: string;
  bitmap: ImageBitmap;
  size: Size;
}

export interface ImageSetState {
  /** `ready`: every requested role has settled, loaded or failed. */
  status: "loading" | "ready";
  images: Partial<Record<ImageRole, LoadedImage>>;
  failed: Partial<Record<ImageRole, true>>;
  /** Fetch a failed role again. Only that role is refetched. */
  retry: (role: ImageRole) => void;
}

const ROLES = ["baseline", "current", "diff"] as const;

/** 12 bitmaps and 400 MB (w x h x 4 bytes each). */
export const BITMAP_CACHE_LIMITS = {
  maxEntries: 12,
  maxBytes: 419_430_400,
} as const;

const BYTES_PER_PIXEL = 4;

// -- the cache ----------------------------------------------------------------

export interface BitmapCache {
  /** The image for `key`, counted as used now; `undefined` when not held. */
  get(key: string): LoadedImage | undefined;
  /**
   * Take an image, then evict the least recently used unpinned images until
   * both limits hold, closing each. The limits count every held image, pinned
   * or not, but only unpinned ones are ever evicted. So a pinned set over
   * budget is allowed, and an unpinned newcomer that does not fit beside it is
   * the one dropped (closed, and not held). If `key` is already held, the held
   * image stays (it may be on screen) and the bitmap offered is closed.
   */
  set(img: LoadedImage): void;
  /**
   * Pin `keys` (a key need not be held yet) so they are never evicted. Pins
   * are counted, so each call needs its own release. The returned function
   * releases them (once; later calls do nothing). A release does not act at
   * once: a microtask later the budget is restored by evicting unpinned
   * entries, and when no pin is left at all the cache is emptied. A pin taken
   * again in the same synchronous run (a step change, a remount) keeps its
   * entry.
   */
  retain(keys: readonly string[]): () => void;
  /** Estimated bytes held. */
  bytes(): number;
  /** Number of images held. */
  size(): number;
}

export function createBitmapCache(limits: {
  maxEntries: number;
  maxBytes: number;
}): BitmapCache {
  // A Map iterates in insertion order, so re-inserting on use keeps the least
  // recently used entry first.
  const entries = new Map<string, LoadedImage>();
  const pins = new Map<string, number>();
  let pinCount = 0;
  let total = 0;
  let settling = false;
  const cost = (img: LoadedImage): number =>
    img.size.w * img.size.h * BYTES_PER_PIXEL;

  /** Evict unpinned entries, oldest first, until the given limits hold. */
  function evict(maxEntries: number, maxBytes: number): void {
    for (const [key, oldest] of entries) {
      if (entries.size <= maxEntries && total <= maxBytes) return;
      if (pins.has(key)) continue;
      entries.delete(key);
      total -= cost(oldest);
      oldest.bitmap.close();
    }
  }

  function get(key: string): LoadedImage | undefined {
    const img = entries.get(key);
    if (img === undefined) return undefined;
    entries.delete(key);
    entries.set(key, img);
    return img;
  }

  function set(img: LoadedImage): void {
    const held = get(img.key);
    if (held !== undefined) {
      if (held.bitmap !== img.bitmap) img.bitmap.close();
      return;
    }
    entries.set(img.key, img);
    total += cost(img);
    evict(limits.maxEntries, limits.maxBytes);
  }

  function settleSoon(): void {
    if (settling) return;
    settling = true;
    queueMicrotask(() => {
      settling = false;
      if (pinCount === 0) evict(0, 0);
      else evict(limits.maxEntries, limits.maxBytes);
    });
  }

  function retain(keys: readonly string[]): () => void {
    const taken = [...new Set(keys)];
    for (const key of taken) pins.set(key, (pins.get(key) ?? 0) + 1);
    pinCount += taken.length;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of taken) {
        const n = (pins.get(key) ?? 1) - 1;
        if (n === 0) pins.delete(key);
        else pins.set(key, n);
      }
      pinCount -= taken.length;
      settleSoon();
    };
  }

  return { get, set, retain, bytes: () => total, size: () => entries.size };
}

/** The one cache the viewer shares. Exported for tests. */
const bitmapCache = createBitmapCache(BITMAP_CACHE_LIMITS);
export const __viewerBitmapCache: BitmapCache = bitmapCache;

/**
 * Pins `keys` in the viewer's cache until the returned function is called:
 * for a holder of bitmaps other than `useImageSet`, such as the stage, which
 * keeps drawing what it mounted until its own cleanup has run, whatever the
 * image set that handed them over has let go of by then. Pins are counted.
 */
export function retainImages(keys: readonly string[]): () => void {
  return bitmapCache.retain(keys);
}

// -- fetch and decode ---------------------------------------------------------

export function storageUrl(key: string): string {
  return `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/storage/${encodeURIComponent(key)}`;
}

/**
 * Decode an image blob into a bitmap.
 *
 * `createImageBitmap(blob)` can be stricter than an image element about some
 * PNG variants, or refuse a blob whose type is missing or wrong. Two fallbacks,
 * cheapest first:
 *   1. the same bytes re-typed as image/png (a zero-copy view);
 *   2. an `HTMLImageElement` fed by an object URL, revoked as soon as the
 *      element has been bitmapped (the bitmap keeps no reference to the URL).
 * Rejects when all three routes fail.
 */
export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch {
    // Fall through to the re-typed blob.
  }
  try {
    return await createImageBitmap(blob.slice(0, blob.size, "image/png"));
  } catch {
    // Fall through to the image element.
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function abortError(): DOMException {
  return new DOMException("The image load was aborted.", "AbortError");
}

async function fetchAndDecode(
  key: string,
  signal: AbortSignal,
): Promise<LoadedImage> {
  const res = await fetch(storageUrl(key), { credentials: "include", signal });
  if (!res.ok) {
    throw new Error(`storage answered ${res.status} for ${key}`);
  }
  const blob = await res.blob();
  if (signal.aborted) throw abortError();
  const bitmap = await decodeImage(blob);
  const image: LoadedImage = {
    key,
    bitmap,
    size: { w: bitmap.width, h: bitmap.height },
  };
  // Decoding cannot be aborted, so a bitmap can finish after everyone stopped
  // waiting for it. It is still the right bitmap for its key: the cache keeps
  // it for the reviewer's next visit, unless it does not fit beside what is
  // pinned, in which case the cache has already closed it.
  bitmapCache.set(image);
  const kept = bitmapCache.get(key);
  if (kept === undefined) {
    throw new Error(`no room in the bitmap cache for ${key}`);
  }
  return kept;
}

/** One network fetch + decode, shared by everyone waiting for the same key. */
interface Flight {
  controller: AbortController;
  promise: Promise<LoadedImage>;
  waiters: number;
}

const flights = new Map<string, Flight>();

function startFlight(key: string): Flight {
  const controller = new AbortController();
  const promise = fetchAndDecode(key, controller.signal).finally(() => {
    if (flights.get(key) === flight) flights.delete(key);
  });
  const flight: Flight = { controller, promise, waiters: 0 };
  flights.set(key, flight);
  return flight;
}

function releaseWaiter(key: string, flight: Flight): void {
  flight.waiters -= 1;
  if (flight.waiters > 0) return;
  // Not yet. The commit that dropped this waiter may take the key up again: the
  // step being opened can be the one whose prefetch is on the wire, and a
  // strict-mode remount re-runs the effect at once. Abort only if nobody did.
  queueMicrotask(() => {
    if (flight.waiters > 0) return;
    if (flights.get(key) === flight) flights.delete(key);
    flight.controller.abort();
  });
}

/**
 * The image for `key`: from the cache, or by joining the fetch already in
 * flight, or by starting one. Rejects with an AbortError as soon as `signal`
 * aborts; the fetch itself is aborted once no waiter is left.
 */
function loadImage(key: string, signal: AbortSignal): Promise<LoadedImage> {
  const cached = bitmapCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  if (signal.aborted) return Promise.reject(abortError());

  const flight = flights.get(key) ?? startFlight(key);
  flight.waiters += 1;
  return new Promise<LoadedImage>((resolve, reject) => {
    const onAbort = (): void => {
      releaseWaiter(key, flight);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      (image) => {
        signal.removeEventListener("abort", onAbort);
        resolve(image);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// -- the hook -----------------------------------------------------------------

interface RoleResult {
  image: LoadedImage | undefined;
  failed: boolean;
  settled: boolean;
}

const NOT_REQUESTED: RoleResult = {
  image: undefined,
  failed: false,
  settled: true,
};
const LOADING: RoleResult = { image: undefined, failed: false, settled: false };

/** How the last finished load of one role ended, and which request it answered. */
interface Outcome {
  key: string;
  attempt: number;
  result: "loaded" | "failed";
}

/**
 * One role's image. The cache answers a key it already holds on the render
 * itself, so a step that was prefetched opens with no loading frame; otherwise
 * an effect loads it. `attempt` restarts a failed load.
 *
 * The image itself is always read from the cache, never kept here: the key is
 * pinned by `useImageSet` for as long as it is requested, so the cache cannot
 * have closed it.
 */
function useRoleImage(key: string | null, attempt: number): RoleResult {
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (key === null || bitmapCache.get(key) !== undefined) return;
    const controller = new AbortController();
    loadImage(key, controller.signal).then(
      () => {
        if (!controller.signal.aborted) {
          setOutcome({ key, attempt, result: "loaded" });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setOutcome({ key, attempt, result: "failed" });
        }
      },
    );
    return () => controller.abort();
  }, [key, attempt]);

  if (key === null) return NOT_REQUESTED;
  const cached = bitmapCache.get(key);
  if (cached !== undefined) {
    return { image: cached, failed: false, settled: true };
  }
  if (
    outcome?.key === key &&
    outcome.attempt === attempt &&
    outcome.result === "failed"
  ) {
    return { image: undefined, failed: true, settled: true };
  }
  return LOADING;
}

const NO_PREFETCH: readonly ImageSetRequest[] = [];

function uniqueKeys(reqs: readonly ImageSetRequest[]): string[] {
  const keys = new Set<string>();
  for (const r of reqs) {
    for (const role of ROLES) {
      const key = r[role];
      if (key !== null) keys.add(key);
    }
  }
  return [...keys];
}

/**
 * The images for one step, and a head start on the next ones.
 *
 * `prefetch` lists the steps to warm, nearest first. They load once the
 * requested set has settled; they never set `failed` and never log, because a
 * missed prefetch only costs the reviewer the load they would have had anyway.
 */
export function useImageSet(
  req: ImageSetRequest,
  prefetch: readonly ImageSetRequest[] = NO_PREFETCH,
): ImageSetState {
  const [attempts, setAttempts] = useState<Record<ImageRole, number>>({
    baseline: 0,
    current: 0,
    diff: 0,
  });
  const baseline = useRoleImage(req.baseline, attempts.baseline);
  const current = useRoleImage(req.current, attempts.current);
  const diff = useRoleImage(req.diff, attempts.diff);

  const retry = useCallback((role: ImageRole): void => {
    setAttempts((a) => ({ ...a, [role]: a[role] + 1 }));
  }, []);

  const ready = baseline.settled && current.settled && diff.settled;

  // Keys, not arrays, drive the effects: callers pass fresh arrays every render.
  const activeKeys = uniqueKeys([req]);
  const activeSig = JSON.stringify(activeKeys);
  const aheadSig = JSON.stringify(
    uniqueKeys(prefetch).filter((key) => !activeKeys.includes(key)),
  );

  // The keys on screen are pinned, whether their image is already cached or
  // still on the wire, so the cache can never close one under the viewer. A
  // layout effect, so the pin is in place before anything can draw the image.
  useLayoutEffect(
    () => bitmapCache.retain(JSON.parse(activeSig) as string[]),
    [activeSig],
  );

  useEffect(() => {
    if (!ready) return;
    const ahead = JSON.parse(aheadSig) as string[];
    if (ahead.length === 0) return;
    const controller = new AbortController();
    for (const key of ahead) {
      loadImage(key, controller.signal).catch(() => {
        // Silent: nothing was asked for yet, so nothing is owed.
      });
    }
    return () => controller.abort();
  }, [ready, aheadSig]);

  const images = useMemo(() => {
    const out: Partial<Record<ImageRole, LoadedImage>> = {};
    if (baseline.image) out.baseline = baseline.image;
    if (current.image) out.current = current.image;
    if (diff.image) out.diff = diff.image;
    return out;
  }, [baseline.image, current.image, diff.image]);

  const failed = useMemo(() => {
    const out: Partial<Record<ImageRole, true>> = {};
    if (baseline.failed) out.baseline = true;
    if (current.failed) out.current = true;
    if (diff.failed) out.diff = true;
    return out;
  }, [baseline.failed, current.failed, diff.failed]);

  return useMemo(
    () => ({ status: ready ? "ready" : "loading", images, failed, retry }),
    [ready, images, failed, retry],
  );
}
