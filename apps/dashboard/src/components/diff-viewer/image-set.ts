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
 * No blob URLs are made anywhere on this path.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

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
   * Take an image. Evicts the least recently used images until both limits
   * hold, closing each evicted bitmap. The image just stored is never evicted
   * by its own insertion, so one image larger than the whole budget is kept
   * rather than closed under its caller. If `key` is already held, the held
   * image stays (it may be on screen) and the bitmap offered is closed.
   */
  set(img: LoadedImage): void;
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
  let total = 0;
  const cost = (img: LoadedImage): number =>
    img.size.w * img.size.h * BYTES_PER_PIXEL;

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
    for (const [key, oldest] of entries) {
      if (key === img.key) break;
      if (entries.size <= limits.maxEntries && total <= limits.maxBytes) break;
      entries.delete(key);
      total -= cost(oldest);
      oldest.bitmap.close();
    }
  }

  return { get, set, bytes: () => total, size: () => entries.size };
}

/** The one cache the viewer shares. Exported for tests. */
const bitmapCache = createBitmapCache(BITMAP_CACHE_LIMITS);
export const __viewerBitmapCache: BitmapCache = bitmapCache;

// -- fetch and decode ---------------------------------------------------------

export function storageUrl(key: string): string {
  return `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/storage/${encodeURIComponent(key)}`;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("could not read the image"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode an image blob into a bitmap.
 *
 * `createImageBitmap(blob)` is stricter than an image element about some PNG
 * variants (odiff's RGBA diff overlay occasionally trips it). When it refuses,
 * decode through an `HTMLImageElement` and bitmap that. A data: URL feeds the
 * element so no object URL is needed. Rejects when both routes fail.
 */
export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch {
    // Fall through to the image element.
  }
  const img = new Image();
  img.src = await readAsDataUrl(blob);
  await img.decode();
  return createImageBitmap(img);
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
  // it (and owns closing it) for the reviewer's next visit.
  bitmapCache.set(image);
  return bitmapCache.get(key) ?? image;
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

/** What the last finished load of one role said, and which request it answered. */
interface Outcome {
  key: string;
  attempt: number;
  result: LoadedImage | "failed";
}

/**
 * One role's image. The cache answers a key it already holds on the render
 * itself, so a step that was prefetched opens with no loading frame; otherwise
 * an effect loads it. `attempt` restarts a failed load.
 */
function useRoleImage(key: string | null, attempt: number): RoleResult {
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (key === null || bitmapCache.get(key) !== undefined) return;
    const controller = new AbortController();
    loadImage(key, controller.signal).then(
      (image) => {
        if (!controller.signal.aborted) {
          setOutcome({ key, attempt, result: image });
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
  // Reading counts as use, which keeps what is on screen away from eviction.
  const cached = bitmapCache.get(key);
  if (cached !== undefined)
    return { image: cached, failed: false, settled: true };
  if (outcome?.key !== key || outcome.attempt !== attempt) return LOADING;
  return outcome.result === "failed"
    ? { image: undefined, failed: true, settled: true }
    : { image: outcome.result, failed: false, settled: true };
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

  // Keys, not arrays, drive the effect: callers pass fresh arrays every render.
  const activeKeys = uniqueKeys([req]);
  const activeSig = JSON.stringify(activeKeys);
  const aheadSig = JSON.stringify(
    uniqueKeys(prefetch).filter((key) => !activeKeys.includes(key)),
  );

  useEffect(() => {
    if (!ready) return;
    const held = JSON.parse(activeSig) as string[];
    const ahead = JSON.parse(aheadSig) as string[];
    if (ahead.length === 0) return;
    const controller = new AbortController();
    for (const key of ahead) {
      loadImage(key, controller.signal).then(
        () => {
          // Whatever just arrived may have pushed the oldest entries out;
          // the images on screen must not be among them.
          for (const k of held) bitmapCache.get(k);
        },
        () => {
          // Silent: nothing was asked for yet, so nothing is owed.
        },
      );
    }
    return () => controller.abort();
  }, [ready, activeSig, aheadSig]);

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
