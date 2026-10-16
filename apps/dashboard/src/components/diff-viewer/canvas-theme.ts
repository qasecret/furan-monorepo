/**
 * Theme bridge for the pixi diff canvas. Pixi cannot read CSS variables, so the
 * canvas colours are resolved from design tokens at runtime and pushed into
 * the live canvas when the theme changes: the letterbox from `--hover`, the
 * hatching from `--fg-muted`. The letterbox reads `--hover` rather than
 * `--sunken` so the bands outside the image stay distinct from a white
 * screenshot in light mode: #f4f4f5 on #fff is 1.10:1, where `--sunken`
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

/** The light theme's `--fg-muted`, for when the token is unset or not a 6-digit hex. */
export const FALLBACK_CANVAS_HATCH = 0x6a6a73;

/**
 * Resolve the current `--fg-muted` token to a pixi colour number: the hatching
 * over the world area an image does not cover. Browser-only, like
 * `readCanvasBackground`.
 */
export function readCanvasHatch(root?: HTMLElement): number {
  const el = root ?? document.documentElement;
  const raw = getComputedStyle(el).getPropertyValue("--fg-muted");
  return cssHexToPixi(raw) ?? FALLBACK_CANVAS_HATCH;
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
