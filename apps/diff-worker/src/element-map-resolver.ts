import type { Storage } from "@furan/storage";

export interface ElementBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementMap {
  v: 1;
  elements: Record<string, ElementBbox>;
  capturedAt: number;
}

export type ResolutionOutcome =
  | "resolved"
  | "no_selector"
  | "no_map"
  | "selector_miss"
  | "invalid_resolved"
  | "fetch_error"
  | "unknown_envelope";

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  selector?: string | undefined;
}

interface Deps {
  storage: Pick<Storage, "get">;
  logger: { warn: (obj: object, msg: string) => void };
  onOutcome?: (outcome: ResolutionOutcome) => void;
}

/**
 * Resolve a region's selector against the candidate screenshot's element
 * map. Returns the resolved bbox when the lookup succeeds + the result is
 * valid, otherwise the stored bbox. Never throws — best-effort everywhere.
 *
 * The `cache` map is per-job: pass the same Map across calls within one
 * diff job to avoid refetching the same sidecar across viewports. Cache
 * value `null` means "this key was fetched and is unusable" (404, parse
 * error, unknown envelope) and short-circuits future calls.
 */
export async function resolveRegionBbox(
  region: Region,
  candidateElementMapKey: string | null,
  bounds: { width: number; height: number },
  cache: Map<string, ElementMap | null>,
  deps: Deps,
): Promise<ElementBbox> {
  const stored: ElementBbox = {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
  };

  if (!region.selector) {
    deps.onOutcome?.("no_selector");
    return stored;
  }
  if (!candidateElementMapKey) {
    deps.onOutcome?.("no_map");
    return stored;
  }

  let map = cache.get(candidateElementMapKey);
  if (map === undefined) {
    map = await fetchElementMap(candidateElementMapKey, deps);
    cache.set(candidateElementMapKey, map);
  }
  if (map === null) {
    // Already-labelled outcome (`fetch_error` or `unknown_envelope`) was
    // emitted on the original fetch; subsequent calls in the same job
    // re-treat as a soft miss without double-counting.
    return stored;
  }

  const hit = map.elements[region.selector];
  if (!hit) {
    deps.onOutcome?.("selector_miss");
    return stored;
  }

  if (!isValidBbox(hit, bounds)) {
    deps.onOutcome?.("invalid_resolved");
    return stored;
  }

  deps.onOutcome?.("resolved");
  return hit;
}

export async function fetchElementMap(
  key: string,
  deps: Deps,
): Promise<ElementMap | null> {
  try {
    const buf = await deps.storage.get(key);
    const text = Buffer.from(buf).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      deps.logger.warn({ key }, "element_map_parse_failed");
      deps.onOutcome?.("fetch_error");
      return null;
    }
    const candidate = parsed as Partial<ElementMap>;
    if (candidate.v !== 1) {
      deps.logger.warn({ key, v: candidate.v }, "element_map_unknown_envelope");
      deps.onOutcome?.("unknown_envelope");
      return null;
    }
    if (typeof candidate.elements !== "object" || candidate.elements === null) {
      deps.logger.warn({ key }, "element_map_no_elements");
      deps.onOutcome?.("fetch_error");
      return null;
    }
    return candidate as ElementMap;
  } catch (err) {
    deps.logger.warn({ key, err }, "element_map_fetch_failed");
    deps.onOutcome?.("fetch_error");
    return null;
  }
}

function isValidBbox(
  bb: ElementBbox,
  bounds: { width: number; height: number },
): boolean {
  if (bb.width < 1 || bb.height < 1) return false;
  if (bb.x < 0 || bb.y < 0) return false;
  if (bb.x + bb.width > bounds.width + 1) return false;
  if (bb.y + bb.height > bounds.height + 1) return false;
  return true;
}
