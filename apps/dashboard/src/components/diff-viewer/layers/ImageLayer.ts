import { type Application, Sprite, Texture } from "pixi.js";

/**
 * Load an image from the api's storage proxy and mount it as a sprite on
 * the given pixi Application's stage.
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
  app: Application,
  imageUrl: string,
): Promise<Sprite> {
  const res = await fetch(imageUrl, { credentials: "include" });
  if (!res.ok) {
    throw new Error(
      `mountImageLayer: ${imageUrl} -> ${res.status} ${res.statusText}`,
    );
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = blobUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () =>
        reject(new Error(`mountImageLayer: decode failed for ${imageUrl}`));
    });
    const texture = Texture.from(img);
    const sprite = new Sprite(texture);
    sprite.width = app.screen.width;
    sprite.height = app.screen.height;
    app.stage.addChild(sprite);
    return sprite;
  } finally {
    // Texture has copied the pixels at this point; the blob URL is no
    // longer needed and would otherwise leak until the Application is
    // GC'd.
    URL.revokeObjectURL(blobUrl);
  }
}
