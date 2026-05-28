import { type Container as PixiContainer, Container, Graphics } from "pixi.js";

import type { BBox, DiffRegion, Severity } from "./regionTypes";

/**
 * Severity → fill color (0xRRGGBB).
 * v1.0 palette per spec §4.4 / §6.2 — high-contrast and color-blind friendly.
 */
const SEVERITY_COLORS: Record<Severity, number> = {
  breaking: 0xff0000,
  major: 0xff8800,
  minor: 0xffdd00,
  cosmetic: 0x4488ff,
  none: 0x888888,
};

function isBBox(v: unknown): v is BBox {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.x === "number" &&
    typeof o.y === "number" &&
    typeof o.width === "number" &&
    typeof o.height === "number"
  );
}

function colorFor(sev: string): number {
  return (
    (SEVERITY_COLORS as Record<string, number>)[sev] ?? SEVERITY_COLORS.none
  );
}

/**
 * Mounts a Container holding one Graphics rect per region into the given
 * parent (typically the per-canvas "world" container). Returns the
 * Container so callers can toggle visibility or detach without touching
 * the rest of the scene tree.
 *
 * When `selectedRegionId` is non-null, three visual tiers are applied:
 *   1. No selection → every region renders at the neutral default (alpha
 *      0.2 fill, 2px stroke alpha 0.9).
 *   2. Selection active, this region IS selected → emphasize with brighter
 *      fill (0.45) + thicker stroke (4px) + a faint outer halo border for
 *      VRT-style pop.
 *   3. Selection active, this region is NOT selected → dimmed (0.05 fill,
 *      1px stroke alpha 0.4) so the eye lands on the selected one.
 */
export function mountDiffOverlayLayer(
  parent: PixiContainer,
  regions: DiffRegion[],
  selectedRegionId: string | null = null,
): Container {
  const container = new Container();
  const hasSelection = selectedRegionId !== null;
  for (const region of regions) {
    if (!isBBox(region.bbox)) continue;
    const { x, y, width, height } = region.bbox;
    if (width === 0 && height === 0) continue;

    const color = colorFor(region.severity);
    const isSelected = region.id === selectedRegionId;

    const fillAlpha = !hasSelection ? 0.2 : isSelected ? 0.45 : 0.05;
    const strokeWidth = !hasSelection ? 2 : isSelected ? 4 : 1;
    const strokeAlpha = !hasSelection ? 0.9 : isSelected ? 1 : 0.4;

    const g = new Graphics();
    g.rect(x, y, width, height)
      .fill({ color, alpha: fillAlpha })
      .stroke({ color, width: strokeWidth, alpha: strokeAlpha });
    container.addChild(g);

    // Selected region also gets a translucent outer halo (a second rect
    // 4px larger on each side) to make it pop on busy diffs.
    if (isSelected) {
      const halo = new Graphics();
      halo
        .rect(x - 4, y - 4, width + 8, height + 8)
        .stroke({ color, width: 2, alpha: 0.4 });
      container.addChild(halo);
    }
  }
  parent.addChild(container);
  return container;
}
