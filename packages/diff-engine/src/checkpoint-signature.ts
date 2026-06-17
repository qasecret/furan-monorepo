import { createHash } from "node:crypto";

import type { DiffRegion } from "./types.js";

/**
 * Region sources excluded from the signature — the noisy clusters and OCR
 * audit rows already hidden from the diff list/stepper. Mirrors the
 * dashboard's `orderDiffRegions` filter so the signature reflects the
 * MEANINGFUL change the reviewer sees.
 */
const EXCLUDED_SOURCES = new Set<string>(["l1_pixel", "dynamic_text"]);

interface SignatureToken {
  category: string;
  severity: string;
  source: string;
  nb: { x: number; y: number; w: number; h: number };
  anchor: string | null;
}

/** Normalize a pixel coordinate to a 0..100 integer bucket of `dim`. */
function bucket(value: number, dim: number): number {
  if (dim <= 0) return 0;
  return Math.round((value / dim) * 100);
}

/**
 * Stable per-checkpoint diff signature (ADR-042). Two checkpoints with the
 * same meaningful change set produce the same signature regardless of region
 * order. Returns `null` when there are no meaningful regions (→ "ungrouped").
 * Excludes l1_pixel/dynamic_text and the volatile `description`; bbox is
 * normalized + bucketed to a 1% grid; `route`/`axeTarget` pin element
 * identity. The `v1:` prefix lets a future algorithm ship as `v2:`.
 */
export function computeCheckpointSignature(
  regions: DiffRegion[],
  imageSize: { width: number; height: number },
): string | null {
  const tokens: SignatureToken[] = regions
    .filter((r) => !EXCLUDED_SOURCES.has(r.source))
    .map((r) => ({
      category: r.category,
      severity: r.severity,
      source: r.source,
      nb: {
        x: bucket(r.bbox.x, imageSize.width),
        y: bucket(r.bbox.y, imageSize.height),
        w: bucket(r.bbox.width, imageSize.width),
        h: bucket(r.bbox.height, imageSize.height),
      },
      anchor:
        r.route !== undefined
          ? `route:${r.route.join(".")}`
          : r.axeTarget !== undefined && r.axeTarget.length > 0
            ? `axe:${r.axeTarget[0]}`
            : null,
    }));

  if (tokens.length === 0) return null;

  tokens.sort((a, b) => {
    const ka = JSON.stringify(a);
    const kb = JSON.stringify(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const hash = createHash("sha256")
    .update(JSON.stringify(tokens))
    .digest("hex");
  return `v1:${hash}`;
}
