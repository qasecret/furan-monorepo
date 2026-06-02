import { type Container, Sprite, Texture } from "pixi.js";

/**
 * Load an image from the api's storage proxy and mount it as a sprite in
 * the given pixi Container (typically the per-canvas "world" container —
 * see ViewerCanvas). The sprite is added at its natural texture size; the
 * world container's transform handles fit-to-canvas + zoom/pan, so all
 * overlays that share the parent (regions, diff highlights) automatically
 * align with the image without each layer doing its own scale math.
 *
 * Why not just `Assets.load(imageUrl)`?
 *  1. Pixi 8 picks its loader by URL extension; our storage URLs are
 *     /api/v1/storage/<sha256> with no extension, so loader resolution
 *     silently picks the wrong one and Sprite construction throws
 *     `Cannot read properties of null (reading 'texture')`.
 *  2. Pixi's default fetch is anonymous. The storage proxy requires auth
 *     (Bearer or the furan_jwt cookie), so cross-origin Pixi requests
 *     would 401 in any deploy where the dashboard and api are on
 *     different origins (the documented self-host shape — see PR #73 /
 *     FURAN_DASHBOARD_ORIGIN).
 *
 * Fix: pre-fetch with credentials (handles auth + cross-origin), convert
 * to a blob URL (same-origin to the browser, no Pixi loader ambiguity),
 * decode via HTMLImageElement (the lowest-common-denominator texture
 * source Pixi destroys cleanly — Texture.from(ImageBitmap) tripped Pixi
 * 8's destroy chain on `_cancelResize`).
 */
export async function mountImageLayer(
  parent: Container,
  imageUrl: string,
  signal?: AbortSignal,
): Promise<Sprite | null> {
  const res = await fetch(imageUrl, { credentials: "include", signal });
  if (!res.ok) {
    throw new Error(
      `mountImageLayer: ${imageUrl} -> ${res.status} ${res.statusText}`,
    );
  }
  const blob = await res.blob();
  if (signal?.aborted) return null;
  // ImageBitmap is a fully-decoded, GPU-ready surface. Unlike the
  // HTMLImageElement path we used before (Image + blob URL), it has
  // no lifetime coupling to a URL: once we hold the bitmap, the
  // underlying blob can be GC'd at our leisure. Earlier the
  // HTMLImageElement path lost a race when React effect cleanup
  // revoked the blob URL while Pixi 8 was still lazily uploading the
  // texture, surfacing as "WebGL: INVALID_VALUE: texImage2D: bad
  // image data" and a black canvas in diff-heatmap mode.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new Error(
      `mountImageLayer: decode failed for ${imageUrl}: ${(err as Error).message}`,
    );
  }
  if (signal?.aborted) {
    bitmap.close();
    return null;
  }
  if (parent.destroyed) {
    bitmap.close();
    return null;
  }
  const texture = Texture.from(bitmap);
  const sprite = new Sprite(texture);
  parent.addChild(sprite);
  return sprite;
}
