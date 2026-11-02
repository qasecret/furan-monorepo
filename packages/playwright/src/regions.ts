import type { Box } from "@furan/client";

/** How the screenshot was taken, which decides its coordinate origin. */
export type CaptureMode =
  | { kind: "viewport" }
  | { kind: "fullPage"; scrollX: number; scrollY: number }
  | { kind: "element"; box: Box };

/**
 * A locator's `boundingBox()` (viewport CSS pixels) in the screenshot's pixels
 * (taken with `scale: "css"`): shifted by the scroll for a full-page shot, or
 * made relative to the element for an element shot, then clipped to the image
 * and rounded outward so the region covers the element. Null when nothing of
 * it is in the image.
 */
export function toImageRegion(
  box: Box,
  mode: CaptureMode,
  image: { width: number; height: number },
): Box | null {
  let { x, y } = box;
  if (mode.kind === "fullPage") {
    x += mode.scrollX;
    y += mode.scrollY;
  } else if (mode.kind === "element") {
    x -= mode.box.x;
    y -= mode.box.y;
  }
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.ceil(x + box.width));
  const y1 = Math.min(image.height, Math.ceil(y + box.height));
  if (box.width <= 0 || box.height <= 0 || x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
