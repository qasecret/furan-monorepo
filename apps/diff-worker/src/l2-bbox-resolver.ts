import type { DiffRegion } from "@furan/diff-engine";
import { stringToObj } from "diff-dom";

import type { ElementMap } from "./element-map-resolver.js";

interface Ast {
  nodeName?: string;
  attributes?: Record<string, string>;
  childNodes?: Ast[];
}

interface L2ResolutionMetric {
  labels: (l: { outcome: "resolved" | "selector_miss" | "route_invalid" }) => {
    inc: () => void;
  };
}

interface Metrics {
  l2Resolution: L2ResolutionMetric;
}

/**
 * Forward-compat: a route segment may step into a non-element node
 * (text/comment) in some diff-dom outputs. The SDK's element-map only
 * contains element nodes, so any path that hits a non-element segment
 * before reaching the target is unresolvable.
 */
function isElementLike(node: Ast | undefined): node is Ast {
  const name = node?.nodeName;
  return (
    !!node &&
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith("#")
  );
}

const SIMPLE_IDENT = /^[a-zA-Z0-9_-]+$/;

/**
 * Build one path segment matching the SDK's cssPath() algorithm in
 * packages/sdk-kotlin/core/.../ElementBboxScript.kt (ELEMENT_BBOX_SCRIPT).
 *
 *   - If the node has an `id`, return `#${id}` (caller treats this as
 *     a path-root reset).
 *   - Else `${tag}` + `.${cls1}.${cls2}...` (all classes whose names
 *     pass the SDK's `/^[a-zA-Z0-9_-]+$/` identifier filter).
 *   - Append `:nth-child(N)` (1-based, among ALL parent children — NOT
 *     just same-tag) ONLY when 2+ siblings share the same tag.
 *
 * Returns null when the node isn't element-like (we don't index those).
 */
function segmentFor(parent: Ast, node: Ast, childIdx: number): string | null {
  const tag = node.nodeName?.toLowerCase();
  if (!tag) return null;
  const id = node.attributes?.["id"];
  if (id) return `#${id}`;
  let part = tag;
  const classAttr = node.attributes?.["class"] ?? "";
  const classes = classAttr
    .split(/\s+/)
    .filter((c) => c.length > 0 && SIMPLE_IDENT.test(c));
  if (classes.length > 0) part += "." + classes.join(".");
  const siblings = parent.childNodes ?? [];
  let sameTagCount = 0;
  for (const s of siblings) {
    if (s.nodeName?.toLowerCase() === tag) sameTagCount++;
  }
  if (sameTagCount > 1) {
    // 1-based; uses the overall child index (NOT same-tag-only index)
    // because the SDK script iterates `parent.children` directly.
    part += `:nth-child(${childIdx + 1})`;
  }
  return part;
}

/**
 * Walk `route` (a diff-dom child-index path) from `root`, building an
 * SDK-format CSS selector along the way. Returns null on any miss.
 *
 * `#id` segments reset the accumulated path to themselves — the SDK
 * stops the selector chain at the nearest #id ancestor, and the
 * element-map's keys match that convention.
 */
function nodeToSdkSelector(root: Ast, route: number[]): string | null {
  if (route.length === 0) return null;
  const segments: string[] = [];
  let cursor: Ast = root;
  for (const idx of route) {
    const children = cursor.childNodes;
    if (!children || idx < 0 || idx >= children.length) return null;
    const next = children[idx];
    if (!isElementLike(next)) return null;
    const seg = segmentFor(cursor, next, idx);
    if (!seg) return null;
    if (seg.startsWith("#")) {
      segments.length = 0;
      segments.push(seg);
    } else {
      segments.push(seg);
    }
    cursor = next;
  }
  return segments.length > 0 ? segments.join(" > ") : null;
}

/**
 * Mutate `regions` in place: for each L2 region with a `route`, derive
 * an SDK-format selector and try to look it up in the element-map.
 * On hit, replace the placeholder `bbox: {0,0,0,0}` with the real
 * bbox. On miss, leave the placeholder untouched (downstream classifier
 * silently falls through).
 *
 * No-ops when candidateDom or elementMap is absent — the caller (worker
 * handler) treats this as graceful degradation, matching the v1 PR #89
 * behavior where L2 bboxes were always {0,0,0,0}.
 */
export function resolveL2Bboxes(
  regions: DiffRegion[],
  candidateDom: string | undefined,
  elementMap: ElementMap | null,
  metrics?: Metrics,
): void {
  if (!candidateDom || !elementMap) return;
  let ast: Ast;
  try {
    ast = stringToObj(candidateDom) as Ast;
  } catch {
    // Unparseable DOM — best-effort: leave every region with the
    // {0,0,0,0} placeholder. The worker's L1 + L2 outputs are still
    // valid; only the per-region bbox resolution is degraded.
    return;
  }
  for (const region of regions) {
    if (region.source !== "l2" || !region.route || region.route.length === 0) {
      continue;
    }
    const selector = nodeToSdkSelector(ast, region.route);
    if (!selector) {
      metrics?.l2Resolution.labels({ outcome: "route_invalid" }).inc();
      continue;
    }
    const bbox = elementMap.elements[selector];
    if (!bbox) {
      metrics?.l2Resolution.labels({ outcome: "selector_miss" }).inc();
      continue;
    }
    region.bbox = bbox;
    metrics?.l2Resolution.labels({ outcome: "resolved" }).inc();
  }
}
