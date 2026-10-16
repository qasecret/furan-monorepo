import { clampZoom, fitScale, type View } from "./viewer-geometry";

/**
 * Compute a {zoom, panX, panY} that frames `bbox` centered in the canvas at
 * a comfortable size (bbox fills ~`targetFill` of the smaller canvas
 * dimension), clamped to the viewer's zoom range. Pure: `imgW × imgH` is the
 * world the stage draws, and the view is applied with the same fit as every
 * other (`transformFor`).
 */
export function computeFocusView(
  bbox: { x: number; y: number; width: number; height: number },
  imgW: number,
  imgH: number,
  screenW: number,
  screenH: number,
  targetFill = 0.6,
): View {
  const fit = fitScale({ w: imgW, h: imgH }, { w: screenW, h: screenH });
  const w = Math.max(bbox.width, 1);
  const h = Math.max(bbox.height, 1);
  const desiredScale = Math.min(
    (screenW * targetFill) / w,
    (screenH * targetFill) / h,
  );
  const zoom = clampZoom(desiredScale / fit);
  const scale = fit * zoom;
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const panX = scale * (imgW / 2 - cx);
  const panY = scale * (imgH / 2 - cy);
  return { zoom, panX, panY };
}
