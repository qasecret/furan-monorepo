import { type Container as PixiContainer, Container, Graphics } from "pixi.js";

import { asSeverity, type BBox, type DiffRegion } from "./regionTypes";

import { SEVERITY_CANVAS_HEX } from "@/lib/severity-style";

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
 *      UI testing-style pop.
 *   3. Selection active, this region is NOT selected → dimmed (0.05 fill,
 *      1px stroke alpha 0.4) so the eye lands on the selected one.
 *
 * `fill: false` draws the outlines alone, every tier's stroke as above with
 * no fill (R28): outside Diff the rectangles sit over the screenshots
 * themselves, and a tint over the changed area would distort the very pixels
 * Swipe, Flicker and Overlay are there to compare. Diff keeps the fill.
 */
export function mountDiffOverlayLayer(
  parent: PixiContainer,
  regions: DiffRegion[],
  selectedRegionId: string | null = null,
  { fill = true }: { fill?: boolean } = {},
): Container {
  const container = new Container();
  const hasSelection = selectedRegionId !== null;
  for (const region of regions) {
    if (!isBBox(region.bbox)) continue;
    const { x, y, width, height } = region.bbox;
    if (width === 0 && height === 0) continue;

    const color = SEVERITY_CANVAS_HEX[asSeverity(region.severity)];
    const isSelected = region.id === selectedRegionId;

    const fillAlpha = !hasSelection ? 0.2 : isSelected ? 0.45 : 0.05;
    const strokeWidth = !hasSelection ? 2 : isSelected ? 4 : 1;
    const strokeAlpha = !hasSelection ? 0.9 : isSelected ? 1 : 0.4;

    const g = new Graphics();
    g.rect(x, y, width, height);
    if (fill) g.fill({ color, alpha: fillAlpha });
    g.stroke({ color, width: strokeWidth, alpha: strokeAlpha });
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
