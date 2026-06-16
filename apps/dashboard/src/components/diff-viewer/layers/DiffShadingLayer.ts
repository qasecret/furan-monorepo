import {
  type Container as PixiContainer,
  Container,
  Graphics,
  type Ticker as PixiTicker,
} from "pixi.js";

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

/** Minimal ticker interface — matches Pixi's Application.ticker shape. */
export interface Ticker {
  add: (fn: (t: PixiTicker) => void) => void;
  remove: (fn: (t: PixiTicker) => void) => void;
}

export interface ShadingLayerOpts {
  /** When true, apply visual emphasis on diff regions (pulse or static ring). */
  highlight?: boolean;
  /**
   * When true AND highlight is on, skip animation and render a static bright
   * ring instead. Satisfies `prefers-reduced-motion`. When false/undefined,
   * register a sinusoidal pulse ticker callback.
   */
  reducedMotion?: boolean;
  /**
   * Pixi Application ticker. Required for the animated pulse path
   * (`highlight && !reducedMotion`). Omitting it falls back to static ring.
   */
  ticker?: Ticker;
}

export interface ShadingLayerResult {
  /** The Container added to `parent`. */
  container: Container;
  /**
   * Tears down the animation ticker callback (if one was registered).
   * Always safe to call — no-op when no animation was started.
   */
  destroy: () => void;
}

/**
 * Mounts pink translucent shading + a severity dot per region onto `parent`.
 * The selected region reads brighter; unselected dim when something is
 * selected — same three-tier emphasis model as mountDiffOverlayLayer.
 *
 * When `opts.highlight` is set:
 * - If `reducedMotion` is false and `ticker` is provided: a sinusoidal pulse
 *   animates each region's ring stroke alpha via a registered ticker callback.
 * - If `reducedMotion` is true (or no ticker): a static bright ring is added
 *   to each region group for zero-motion emphasis.
 *
 * Returns `{ container, destroy }`. Call `destroy()` in the effect cleanup to
 * unregister the ticker callback and prevent memory leaks.
 */
export function mountDiffShadingLayer(
  parent: PixiContainer,
  regions: DiffRegion[],
  selectedRegionId: string | null = null,
  opts: ShadingLayerOpts = {},
): ShadingLayerResult {
  const { highlight = false, reducedMotion = false, ticker } = opts;

  const container = new Container();
  const hasSelection = selectedRegionId !== null;

  // Collect the pulsing Graphics per region so the ticker can update them.
  const pulseRings: Array<{
    g: Graphics;
    x: number;
    y: number;
    w: number;
    h: number;
  }> = [];

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

    if (highlight) {
      if (reducedMotion || !ticker) {
        // Static bright ring — no motion, just an additional opaque ring.
        const ring = new Graphics();
        ring
          .rect(x - 2, y - 2, width + 4, height + 4)
          .stroke({ color: PINK, width: 3, alpha: 1 });
        group.addChild(ring);
      } else {
        // Animated pulse ring — added to group, driven by ticker below.
        const ring = new Graphics();
        ring
          .rect(x - 2, y - 2, width + 4, height + 4)
          .stroke({ color: PINK, width: 3, alpha: 1 });
        group.addChild(ring);
        pulseRings.push({
          g: ring,
          x: x - 2,
          y: y - 2,
          w: width + 4,
          h: height + 4,
        });
      }
    }

    container.addChild(group);
  }

  parent.addChild(container);

  // Register ticker for animated pulse when conditions are met.
  let tickerCallback: ((t: PixiTicker) => void) | null = null;

  if (highlight && !reducedMotion && ticker && pulseRings.length > 0) {
    // Accumulate time via the Pixi v8 Ticker instance passed to the callback.
    // In Pixi v8, ticker callbacks receive the Ticker object (not a raw number);
    // deltaTime is frame-time-scaled (1.0 at 60fps, 2.0 at 30fps, etc.).
    let elapsed = 0;
    tickerCallback = (t: PixiTicker) => {
      const d = t.deltaTime;
      elapsed += d;
      // Oscillate between 0.3 and 1.0; period scales with deltaTime so the
      // animation speed is consistent regardless of frame rate.
      const alpha = 0.65 + 0.35 * Math.sin(elapsed * 0.07);
      for (const { g, x, y, w, h } of pulseRings) {
        g.clear();
        g.rect(x, y, w, h).stroke({ color: PINK, width: 3, alpha });
      }
    };
    ticker.add(tickerCallback);
  }

  const destroy = (): void => {
    if (tickerCallback && ticker) {
      ticker.remove(tickerCallback);
      tickerCallback = null;
    }
  };

  return { container, destroy };
}
