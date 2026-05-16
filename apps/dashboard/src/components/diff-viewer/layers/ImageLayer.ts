import { type Application, Assets, Sprite } from "pixi.js";

/**
 * T8: minimal helper that loads a texture and mounts a sprite onto the
 * given pixi Application's stage. T9 will replace placeholder URLs with
 * an authenticated storage proxy fetch.
 */
export async function mountImageLayer(
  app: Application,
  imageUrl: string,
): Promise<Sprite> {
  const texture = await Assets.load(imageUrl);
  const sprite = new Sprite(texture);
  sprite.width = app.screen.width;
  sprite.height = app.screen.height;
  app.stage.addChild(sprite);
  return sprite;
}
