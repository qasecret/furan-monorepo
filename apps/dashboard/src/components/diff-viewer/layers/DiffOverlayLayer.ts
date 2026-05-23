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
 */
export function mountDiffOverlayLayer(
  parent: PixiContainer,
  regions: DiffRegion[],
): Container {
  const container = new Container();
  for (const region of regions) {
    if (!isBBox(region.bbox)) continue;
    const { x, y, width, height } = region.bbox;
    if (width === 0 && height === 0) continue;

    const color = colorFor(region.severity);
    const g = new Graphics();
    g.rect(x, y, width, height)
      .fill({ color, alpha: 0.2 })
      .stroke({ color, width: 2, alpha: 0.9 });
    container.addChild(g);
  }
  parent.addChild(container);
  return container;
}
