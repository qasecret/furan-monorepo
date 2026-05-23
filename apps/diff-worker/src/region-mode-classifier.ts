import type { DiffRegion } from "@furan/diff-engine";

import { bboxIntersects, type BBox } from "./bbox.js";

export interface ReviewerRegion {
  kind: string;
  bbox: BBox;
}

/**
 * Apply Layout + Content reviewer regions to the L2 region set in place.
 * Returns a (possibly shorter) array — Content's filter can suppress
 * non-text L2 regions, so the return is not the same length as the
 * input.
 *
 * Order of operations:
 *   1. Layout pass: any L2 region intersecting a layout bbox is
 *      re-tagged to severity=major, category=layout.
 *   2. Content pass: inside a content bbox, only text-category L2
 *      regions survive (re-tagged major). Other categories are dropped.
 *
 * Layout runs first so an op inside both regions gets the more specific
 * content treatment. (An attribute change inside both Layout AND
 * Content is suppressed — the reviewer asked for "only text" in the
 * Content region, and that intent is more restrictive than Layout's
 * "tag everything as positional.")
 *
 * L1 regions are never touched. Zero-size L2 bboxes (unresolved by
 * l2-bbox-resolver) never intersect — they pass through unchanged.
 */
export function classifyLayoutContent(
  regions: DiffRegion[],
  reviewerRegions: ReviewerRegion[],
): DiffRegion[] {
  const layout = reviewerRegions.filter((r) => r.kind === "layout");
  const content = reviewerRegions.filter((r) => r.kind === "content");
  if (layout.length === 0 && content.length === 0) return regions;

  // Record original categories before any mutation so the Content pass
  // can apply the "text-only" filter against what the DOM engine actually
  // produced, not against the Layout-retagged value.
  const originalCategory = new Map<string, DiffRegion["category"]>();
  for (const region of regions) {
    if (region.source === "l2") {
      originalCategory.set(region.id, region.category);
    }
  }

  // Layout pass (mutate in place).
  if (layout.length > 0) {
    for (const region of regions) {
      if (region.source !== "l2") continue;
      if (layout.some((l) => bboxIntersects(region.bbox, l.bbox))) {
        region.severity = "major";
        region.category = "layout";
        region.description = `Layout region: ${region.description}`;
      }
    }
  }

  // Content pass (filter + mutate).
  // Runs after Layout so Content's stricter "only text" intent wins when
  // a region falls inside both kinds of reviewer bbox.
  // Uses originalCategory to honour the DOM engine's classification, not
  // the Layout-retagged value — a text change is still text even if a
  // reviewer also drew a Layout box over the same area.
  if (content.length === 0) return regions;
  const survivors: DiffRegion[] = [];
  for (const region of regions) {
    if (region.source !== "l2") {
      survivors.push(region);
      continue;
    }
    const inContent = content.some((c) => bboxIntersects(region.bbox, c.bbox));
    if (!inContent) {
      survivors.push(region);
      continue;
    }
    if (originalCategory.get(region.id) === "text") {
      region.severity = "major";
      region.description = `Content region: ${region.description}`;
      region.category = "text"; // restore text category — content intent wins over layout retag
      survivors.push(region);
    }
    // else: suppressed — reviewer explicitly scoped this area to text-only changes.
  }
  return survivors;
}
