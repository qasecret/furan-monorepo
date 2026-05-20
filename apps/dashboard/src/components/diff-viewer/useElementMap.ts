import { useEffect, useRef, useState } from "react";

import { browserEnv } from "@/lib/env";

/**
 * Per-element bounding box from the SDK's snapshot-time element map
 * (PR #61). Coordinates are in image-pixel space, identical to the
 * coordinate system used by the ignore-region editor.
 */
export interface ElementBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Sidecar JSON shape served at `${imageKey}.elements.json`. Versioned
 * (`v: 1`) so future schema bumps degrade silently instead of crashing
 * the editor — a `v !== 1` payload is treated as "no element map."
 */
export interface ElementMap {
  v: 1;
  elements: Record<string, ElementBbox>;
  capturedAt: number;
}

type State = "idle" | "loading" | "ready" | "error";

export interface Cached {
  /** `null` when the sidecar is missing, malformed, or version-skewed. */
  map: ElementMap | null;
  state: State;
}

/**
 * Module-level cache keyed by `elementMapKey`. Persists across component
 * remounts (e.g. toggling edit mode), so each key fetches at most once
 * per session. Failures cache as `{ map: null, state: "error" }` so a
 * 404 doesn't thrash the proxy on every re-render.
 */
const cache = new Map<string, Cached>();

/** Test-only: reset the module-level cache between cases. */
export function __resetElementMapCacheForTests(): void {
  cache.clear();
}

/**
 * Lazily fetches + parses the element-map sidecar for the given key.
 * Pass `null` / `undefined` to opt out of fetching (returns the `idle`
 * state). This is the rules-of-hooks-safe way to conditionally enable
 * the fetch — the hook itself is always called.
 *
 * Why not react-query: the sidecar is small, browser-cached by the
 * storage proxy's `Cache-Control: max-age=300, immutable`, and the
 * lifecycle is "fetch once per session per key." 30 LOC of bespoke
 * cache + manual subscription beats wiring a query client for a single
 * endpoint.
 */
export function useElementMap(
  elementMapKey: string | null | undefined,
): Cached {
  const [, force] = useState({});
  const keyRef = useRef(elementMapKey);
  keyRef.current = elementMapKey;

  useEffect(() => {
    if (!elementMapKey) return;
    if (cache.has(elementMapKey)) return;
    cache.set(elementMapKey, { map: null, state: "loading" });
    force({});
    void (async () => {
      try {
        const res = await fetch(
          `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/storage/${elementMapKey}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          cache.set(elementMapKey, { map: null, state: "error" });
          if (keyRef.current === elementMapKey) force({});
          return;
        }
        const parsed: unknown = await res.json();
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { v?: unknown }).v === 1 &&
          typeof (parsed as { elements?: unknown }).elements === "object" &&
          (parsed as { elements?: unknown }).elements !== null
        ) {
          cache.set(elementMapKey, {
            map: parsed as ElementMap,
            state: "ready",
          });
        } else {
          cache.set(elementMapKey, { map: null, state: "error" });
        }
      } catch {
        cache.set(elementMapKey, { map: null, state: "error" });
      }
      if (keyRef.current === elementMapKey) force({});
    })();
  }, [elementMapKey]);

  if (!elementMapKey) return { map: null, state: "idle" };
  return cache.get(elementMapKey) ?? { map: null, state: "loading" };
}
