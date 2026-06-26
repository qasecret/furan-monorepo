import type { Bbox, DiffRegion, ElementMap, MatchCandidate } from "../types.js";

function intersectionArea(a: Bbox, b: Bbox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return 0;
  return (x1 - x0) * (y1 - y0);
}

function unionBbox(boxes: Bbox[]): Bbox {
  let x = Infinity;
  let y = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x = Math.min(x, b.x);
    y = Math.min(y, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  return { x, y, width: x2 - x, height: y2 - y };
}

function bboxArea(b: Bbox): number {
  return b.width * b.height;
}

export function selectorMatcher(
  selectorValue: unknown,
  region: DiffRegion,
  elementMap: ElementMap | null,
): MatchCandidate {
  const noMatch: MatchCandidate = {
    matched: false,
    overlap: 0,
    resolvedSelector: null,
  };

  if (!elementMap) return noMatch;

  const selector = String(selectorValue);
  const matching = elementMap.filter((e) => e.selector === selector);
  if (matching.length === 0) return noMatch;

  const regionArea = bboxArea(region.bbox);
  if (regionArea <= 0) return noMatch;

  const union = unionBbox(matching.map((e) => e.bbox));
  const overlap = intersectionArea(union, region.bbox) / regionArea;

  if (overlap <= 0) return noMatch;

  return {
    matched: true,
    overlap,
    resolvedSelector: selector,
  };
}
