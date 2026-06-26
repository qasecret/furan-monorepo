import type { ElementMap as RulesElementMap } from "@furan/rules-engine";
import { JSDOM } from "jsdom";

import type { ElementMap } from "./element-map-resolver.js";
import { buildSdkSelectorFromAncestors } from "./element-map-selector.js";

export type RuleSelectorResolution =
  | "resolved"
  | "resolved_ancestor"
  | "selector_miss"
  | "invalid_selector"
  | "dom_unparseable";

interface ResolutionMetric {
  labels: (l: { outcome: RuleSelectorResolution }) => { inc: () => void };
}

interface Metrics {
  rulesSelectorResolution: ResolutionMetric;
}

/**
 * Resolve auto-rule CSS selectors against the candidate screenshot's DOM +
 * element-map sidecar, producing an engine-shaped element map keyed by the
 * ORIGINAL rule-selector string. The rules engine's selector matcher does an
 * exact `entry.selector === rule.match.value` lookup, so emitting entries keyed
 * by the rule value (not the SDK cssPath) lets the pure engine stay unchanged
 * while the DOM-aware matching happens here — the same layering as
 * `resolveAxeBboxes` (engine is storage/DOM-agnostic; resolvers live in the
 * diff-worker; see CLAUDE.md).
 *
 * Why a real DOM and not key-parsing: the SDK cssPath keys encode only
 * tag/id/class/nth-child, so attribute selectors like `[data-time]` (a
 * canonical rule example) can ONLY be matched against the live DOM via
 * `querySelectorAll`. Each matched element is mapped to its SDK cssPath and
 * looked up leaf→ancestor in the element-map (smallest mapped ancestor wins —
 * the SDK drops sub-8px / hidden elements, so leaves routinely fall back).
 *
 * Never throws — best-effort everywhere. Returns `[]` when the DOM or
 * element-map is absent (selector rules stay inert, no fallback, no guessing).
 */
export function resolveRuleSelectorElementMap(
  selectors: string[],
  candidateDom: string | undefined,
  elementMap: ElementMap | null,
  metrics?: Metrics,
): RulesElementMap {
  if (!candidateDom || !elementMap || selectors.length === 0) return [];

  let dom: JSDOM;
  try {
    dom = new JSDOM(candidateDom);
  } catch {
    metrics?.rulesSelectorResolution
      .labels({ outcome: "dom_unparseable" })
      .inc();
    return [];
  }

  const out: RulesElementMap = [];
  // De-dupe identical (selector, bbox) pairs — several matched elements can
  // fall back to the same mapped ancestor.
  const seen = new Set<string>();

  try {
    const doc = dom.window.document;
    for (const selector of selectors) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = doc.querySelectorAll(selector);
      } catch {
        // Invalid CSS (user-authored) — treat as matching nothing.
        metrics?.rulesSelectorResolution
          .labels({ outcome: "invalid_selector" })
          .inc();
        continue;
      }

      for (const node of nodes) {
        const candidates = buildSdkSelectorFromAncestors(node);
        let resolved = false;
        // Walk leaf → root so the SMALLEST mapped ancestor wins.
        for (let i = candidates.length - 1; i >= 0; i--) {
          const sdkSelector = candidates[i];
          if (sdkSelector === undefined) continue;
          const bbox = elementMap.elements[sdkSelector];
          if (!bbox) continue;
          const key = `${selector}|${bbox.x},${bbox.y},${bbox.width},${bbox.height}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({ selector, bbox });
          }
          metrics?.rulesSelectorResolution
            .labels({
              outcome:
                i === candidates.length - 1 ? "resolved" : "resolved_ancestor",
            })
            .inc();
          resolved = true;
          break;
        }
        if (!resolved) {
          metrics?.rulesSelectorResolution
            .labels({ outcome: "selector_miss" })
            .inc();
        }
      }
    }
  } finally {
    dom.window.close();
  }

  return out;
}
