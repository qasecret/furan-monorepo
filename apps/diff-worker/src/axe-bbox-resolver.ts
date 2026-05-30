import type { DiffRegion } from "@furan/diff-engine";
import { JSDOM } from "jsdom";

import type { ElementMap } from "./element-map-resolver.js";
import { buildSdkSelectorFromAncestors } from "./element-map-selector.js";

interface AxeResolutionMetric {
  labels: (l: {
    outcome:
      | "resolved"
      | "resolved_ancestor"
      | "selector_miss"
      | "dom_unparseable"
      | "no_target";
  }) => { inc: () => void };
}

interface Metrics {
  axeResolution: AxeResolutionMetric;
}

/**
 * Mutate `regions` in place: for each axe region with an `axeTarget`,
 * resolve the violating element via jsdom + the element-map sidecar,
 * replace the placeholder `bbox: {0,0,0,0}` with the real bbox.
 *
 * Algorithm (spec §4.4):
 *  1. `querySelector(axeTarget[0])` on the candidate DOM to find the
 *     violating node.
 *  2. Build the leaf's SDK-format selector and every ancestor
 *     selector up to the nearest #id (via
 *     [buildSdkSelectorFromAncestors]).
 *  3. Walk LEAF → ROOT looking for a hit in [elementMap.elements].
 *     First hit wins (smallest containing ancestor).
 *     - Exact hit on the leaf -> outcome `resolved`.
 *     - Any ancestor hit      -> outcome `resolved_ancestor`. The
 *       SDK's element-map skips elements with width < 8 or
 *       height < 8 or display:none / visibility:hidden, so small
 *       icons/inputs/buttons routinely fall back to an ancestor.
 *  4. No hit at any level -> outcome `selector_miss`, bbox unchanged.
 *
 * No-ops when `candidateDom` or `elementMap` is absent — matches the
 * L2 resolver's graceful-degradation contract.
 *
 * Multi-frame axe targets (length > 1, iframe traversal) are not
 * supported in v1; only `axeTarget[0]` is consulted. Furan's DOM
 * capture is single-frame today.
 *
 * Only regions with `source === 'axe'` are touched. L1/L2 regions
 * are left alone.
 */
export function resolveAxeBboxes(
  regions: DiffRegion[],
  candidateDom: string | undefined,
  elementMap: ElementMap | null,
  metrics?: Metrics,
): void {
  if (!candidateDom || !elementMap) return;

  const axeRegions = regions.filter((r) => r.source === "axe");
  if (axeRegions.length === 0) return;

  let dom: JSDOM;
  try {
    dom = new JSDOM(candidateDom);
  } catch {
    for (const _ of axeRegions) {
      metrics?.axeResolution.labels({ outcome: "dom_unparseable" }).inc();
    }
    return;
  }

  try {
    const doc = dom.window.document;
    for (const region of axeRegions) {
      if (!region.axeTarget || region.axeTarget.length === 0) {
        metrics?.axeResolution.labels({ outcome: "no_target" }).inc();
        continue;
      }
      const selector = region.axeTarget[0];
      if (selector === undefined) {
        metrics?.axeResolution.labels({ outcome: "no_target" }).inc();
        continue;
      }
      let node: Element | null;
      try {
        node = doc.querySelector(selector);
      } catch {
        // Invalid CSS selector — treat as miss.
        metrics?.axeResolution.labels({ outcome: "selector_miss" }).inc();
        continue;
      }
      if (!node) {
        metrics?.axeResolution.labels({ outcome: "selector_miss" }).inc();
        continue;
      }
      const candidates = buildSdkSelectorFromAncestors(node);
      let resolvedExact = false;
      let resolvedAncestor = false;
      // Walk leaf → root (iterate in reverse) so the SMALLEST
      // matching ancestor wins.
      for (let i = candidates.length - 1; i >= 0; i--) {
        const sdkSelector = candidates[i];
        if (sdkSelector === undefined) continue;
        const bbox = elementMap.elements[sdkSelector];
        if (bbox) {
          region.bbox = bbox;
          if (i === candidates.length - 1) {
            resolvedExact = true;
          } else {
            resolvedAncestor = true;
          }
          break;
        }
      }
      if (resolvedExact) {
        metrics?.axeResolution.labels({ outcome: "resolved" }).inc();
      } else if (resolvedAncestor) {
        metrics?.axeResolution.labels({ outcome: "resolved_ancestor" }).inc();
      } else {
        metrics?.axeResolution.labels({ outcome: "selector_miss" }).inc();
      }
    }
  } finally {
    dom.window.close();
  }
}
