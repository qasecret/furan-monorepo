import { PNG } from "pngjs";

export interface IgnoreArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Paints transparent RGBA (0,0,0,0) rectangles over each area of the
 * provided PNG and returns a new PNG buffer. Used by pixelmatch and
 * looks-same backends, which don't natively support ignore regions.
 * Alpha=0 tells pixelmatch to treat these pixels as "don't care",
 * so they are excluded from comparison rather than matched.
 *
 * Areas extending past image bounds are clamped. An empty `areas` array
 * returns the input buffer unchanged.
 */
export function applyIgnoreMask(pngBytes: Buffer, areas: IgnoreArea[]): Buffer {
  if (areas.length === 0) return pngBytes;
  const png = PNG.sync.read(pngBytes);
  const { width, height, data } = png;
  for (const area of areas) {
    const x0 = Math.max(0, Math.floor(area.x));
    const y0 = Math.max(0, Math.floor(area.y));
    const x1 = Math.min(width, Math.floor(area.x + area.width));
    const y1 = Math.min(height, Math.floor(area.y + area.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 0;
      }
    }
  }
  return PNG.sync.write(png);
}
