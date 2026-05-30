import { createHash } from "node:crypto";

import axeCore from "axe-core";
import { JSDOM } from "jsdom";

import type { DiffRegion, Severity } from "./types.js";

/**
 * Tier 2.5 (Eyes-parity `accessibilitySettings`): run axe-core against
 * the captured DOM HTML and translate violations into [DiffRegion]
 * rows with `source = 'axe'`, `category = 'accessibility'`.
 *
 * Each axe violation generates one region per affected node. The
 * region's `bbox` is `{0,0,0,0}` (DOM-only; pixel-localisation is
 * a follow-up engine pass that resolves the axe `target` CSS path
 * against the captured element-map sidecar). Description carries the
 * rule id + short help text so the dashboard's Root Cause view can
 * surface it readably.
 *
 * Selection of axe rule tags follows the standard tag groups:
 *  - WCAG 2.0 AA: `wcag2a` + `wcag2aa`
 *  - WCAG 2.0 AAA: + `wcag2aaa`
 *  - WCAG 2.1 AA: above + `wcag21a` + `wcag21aa`
 *  - WCAG 2.1 AAA: above + `wcag21aaa`
 */
export interface AccessibilityOptions {
  level: "AA" | "AAA";
  version: "WCAG_2_0" | "WCAG_2_1";
}

export async function runAxe(
  domHtml: string,
  options: AccessibilityOptions,
): Promise<DiffRegion[]> {
  const tags = tagsFor(options);
  const dom = new JSDOM(domHtml, { runScripts: undefined });
  // axe-core's jsdom path requires `window` and `document` available
  // as globals (it falls through to setupGlobals → setupBrowser which
  // reads them from globalThis). Set + restore on each run so
  // concurrent diff-worker jobs don't leak the jsdom window between
  // checkpoints.
  const prevWindow = (globalThis as { window?: unknown }).window;
  const prevDocument = (globalThis as { document?: unknown }).document;
  (globalThis as unknown as { window: unknown }).window = dom.window;
  (globalThis as unknown as { document: unknown }).document =
    dom.window.document;
  try {
    // axe-core accepts `Document | Element | NodeList | string`; pass
    // `documentElement` (typed as Element) which avoids the
    // cross-realm Document-shape check that fires when jsdom is
    // running inside the test env's own jsdom (vitest jsdom mode).
    const results = await axeCore.run(
      dom.window.document.documentElement as unknown as Element,
      {
        runOnly: { type: "tag", values: tags },
        // Resulting violations include all impact levels by default;
        // we map them to Furan severities below.
        resultTypes: ["violations"],
      },
    );
    return results.violations.flatMap((v) => {
      // Cap at 50 nodes per rule — axe can produce hundreds of nodes
      // for a single rule on a misconfigured page (e.g. one missing
      // alt on a 200-image gallery), which would drown the Root Cause
      // view. 50 is enough to be representative without crowding.
      const nodes = v.nodes.slice(0, 50);
      return nodes.map((node) => {
        // axe-core types `node.target` as `CrossTreeSelector[]` which is
        // `Array<string | string[][]>`. Shadow-DOM nodes get the nested
        // `string[][]` form; normal single-frame DOM gets flat strings.
        // Furan's single-frame DOM capture doesn't traverse shadow-DOM
        // yet, so we drop the nested entries and forward the flat ones.
        // The resolver (apps/diff-worker/src/axe-bbox-resolver.ts)
        // consumes a clean `string[]`.
        const flatTarget = Array.isArray(node.target)
          ? node.target.filter((s): s is string => typeof s === "string")
          : [];
        return {
          id: createHash("sha256")
            .update(v.id + (node.target.join(",") || ""))
            .digest("hex")
            .slice(0, 16),
          severity: mapImpact(v.impact),
          category: "accessibility" as const,
          bbox: { x: 0, y: 0, width: 0, height: 0 },
          source: "axe" as const,
          description: `${v.id}: ${v.help}`.slice(0, 200),
          ...(flatTarget.length > 0 ? { axeTarget: flatTarget } : {}),
        };
      });
    });
  } finally {
    // Restore the globals so other code in the worker process (or
    // parallel diff jobs) doesn't pick up our jsdom window.
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as unknown as { window: unknown }).window = prevWindow;
    }
    if (prevDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as unknown as { document: unknown }).document = prevDocument;
    }
    // jsdom keeps timers alive; explicit close() prevents the worker
    // process from hanging on shutdown.
    dom.window.close();
  }
}

/**
 * Pure helper: map AccessibilityOptions to the axe-core rule tags.
 * Exported for unit testing — the rule-tag mapping is what controls
 * which violations surface, so it's the part most worth pinning down
 * vs the rest of the integration which is exercised end-to-end in
 * the diff-worker tests.
 */
export function tagsFor(options: AccessibilityOptions): string[] {
  const tags = ["wcag2a", "wcag2aa"];
  if (options.level === "AAA") tags.push("wcag2aaa");
  if (options.version === "WCAG_2_1") {
    tags.push("wcag21a", "wcag21aa");
    if (options.level === "AAA") tags.push("wcag21aaa");
  }
  return tags;
}

/**
 * Pure helper: map axe-core impact strings to Furan severities.
 * Exported for unit testing.
 */
export function mapImpact(
  impact: "minor" | "moderate" | "serious" | "critical" | null | undefined,
): Severity {
  switch (impact) {
    case "critical":
      return "breaking";
    case "serious":
      return "major";
    case "moderate":
      return "minor";
    case "minor":
      return "cosmetic";
    default:
      return "minor";
  }
}
