/**
 * Theme bridge for the pixi diff canvas. Pixi cannot read CSS variables, so the
 * letterbox colour is resolved from the `--hover` design token at runtime and
 * pushed into each live renderer when the theme changes. It reads `--hover`
 * rather than `--sunken` so the bands outside the image stay distinct from a
 * white screenshot in light mode: #f4f4f5 on #fff is 1.10:1, where `--sunken`
 * (#fafafa) is 1.04:1.
 */

/** Used when `--hover` is unset or not a 6-digit hex (e.g. under jsdom). */
export const FALLBACK_CANVAS_BG = 0xf3f4f6;

const HEX6 = /^#([0-9a-f]{6})$/i;

/** "#08080a" / " #08080A " -> 0x08080a. Anything else (rgb(), short hex, "") -> null. */
export function cssHexToPixi(value: string): number | null {
  const match = HEX6.exec(value.trim());
  return match ? parseInt(match[1]!, 16) : null;
}

/**
 * Resolve the current `--hover` token to a pixi colour number. Browser-only:
 * it reads `document` (and computed style), so call it from an effect, never
 * during server rendering.
 */
export function readCanvasBackground(root?: HTMLElement): number {
  const el = root ?? document.documentElement;
  const raw = getComputedStyle(el).getPropertyValue("--hover");
  return cssHexToPixi(raw) ?? FALLBACK_CANVAS_BG;
}

/** Set the background of every initialised app; apps without a renderer yet are skipped. */
export function applyCanvasBackground(
  apps: ReadonlyArray<{ renderer?: { background: { color: unknown } } }>,
  color: number,
): void {
  for (const app of apps) {
    if (app.renderer) app.renderer.background.color = color;
  }
}
