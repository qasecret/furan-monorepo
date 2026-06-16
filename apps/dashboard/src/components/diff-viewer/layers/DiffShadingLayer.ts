import { type Container as PixiContainer, Container, Graphics } from "pixi.js";

import type { BBox, DiffRegion, Severity } from "./regionTypes";

/** Applitools-style pink shading for changed pixels. */
const PINK = 0xff4f9a;

/** Severity → dot color (reused from DiffOverlayLayer's palette). */
const SEVERITY_DOT: Record<Severity, number> = {
  breaking: 0xff0000,
  major: 0xff8800,
  minor: 0xffdd00,
  cosmetic: 0x4488ff,
  none: 0x888888,
};

function isBBox(v: unknown): v is BBox {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof o[k] === "number");
}

function dotColor(sev: string): number {
  return (SEVERITY_DOT as Record<string, number>)[sev] ?? SEVERITY_DOT.none;
}

/**
 * Mounts pink translucent shading + a severity dot per region onto `parent`.
 * The selected region reads brighter; unselected dim when something is
 * selected — same three-tier emphasis model as mountDiffOverlayLayer.
 * Returns the container so callers can detach it.
 */
export function mountDiffShadingLayer(
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
    const isSelected = region.id === selectedRegionId;
    const fillAlpha = !hasSelection ? 0.3 : isSelected ? 0.42 : 0.12;
    const strokeAlpha = !hasSelection ? 0.9 : isSelected ? 1 : 0.4;

    const group = new Container();
    const g = new Graphics();
    g.rect(x, y, width, height)
      .fill({ color: PINK, alpha: fillAlpha })
      .stroke({ color: PINK, width: isSelected ? 3 : 1.5, alpha: strokeAlpha });
    group.addChild(g);

    const dot = new Graphics();
    dot
      .circle(x + width, y, 5)
      .fill({ color: dotColor(region.severity), alpha: 1 });
    group.addChild(dot);

    container.addChild(group);
  }
  parent.addChild(container);
  return container;
}
