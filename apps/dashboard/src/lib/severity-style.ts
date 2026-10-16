import type { Severity } from "@furan/shared-types";

/**
 * The ONLY diff-region severity colours in the dashboard: the chip classes
 * (`SEVERITY_STYLE`) and the canvas hex (`SEVERITY_CANVAS_HEX`). Order and
 * display names are not here; they come from `@furan/shared-types`. Everything
 * reads from here, so a severity looks the same everywhere: the diff viewer's
 * region badges (RegionItem), the run header's aggregate pill
 * (AggregateSeverityPill), the worst-severity stat in the viewer's info
 * sidebar (TestInfoSidebar), and the region boxes and dots the canvas layers
 * draw (DiffOverlayLayer, DiffShadingLayer).
 *
 * Chips (`SEVERITY_STYLE`): severity isn't a run status, so it keeps its own
 * hues rather than status tokens (Ruling R18): an opaque pastel `-100` chip
 * with `-800` text and a `-300` border, the same in both themes with no
 * `dark:` override. That is AA on the chip itself (6.4–7.3:1) whatever surface
 * sits behind it. The border style varies too (cosmetic dashed, none dotted)
 * so the meaning doesn't rest on colour alone. `none` is neutral: there is no
 * hue for "no severity". It sits on `bg-edge`, a step above the hover surface,
 * so it stays visible in a hovered or selected region row (those paint
 * `bg-hover`); `text-fg-secondary` on it is 6.1:1 light, 5.9:1 dark. Its dotted
 * border is `edge-strong`: an `edge` border would vanish into the `edge` fill
 * and take the shape cue with it.
 *
 * Every class is a full literal string: Tailwind's scanner cannot see class
 * names assembled at runtime. Typed by severity, so a new level is a compile
 * error.
 */
export const SEVERITY_STYLE = {
  breaking: "border-red-300 bg-red-100 text-red-800",
  major: "border-orange-300 bg-orange-100 text-orange-800",
  minor: "border-yellow-300 bg-yellow-100 text-yellow-800",
  cosmetic: "border-blue-300 border-dashed bg-blue-100 text-blue-800",
  none: "border-edge-strong border-dotted bg-edge text-fg-secondary",
} as const satisfies Record<Severity, string>;

/**
 * Severity -> canvas colour (0xRRGGBB) for the pixi layers, which paint with
 * numbers rather than classes. It is the one exception to reading canvas
 * colours from CSS tokens: a severity keeps its hue in both themes, as the
 * chips do. High-contrast and colour-blind friendly (spec §4.4 / §6.2).
 */
export const SEVERITY_CANVAS_HEX: Record<Severity, number> = {
  breaking: 0xff0000,
  major: 0xff8800,
  minor: 0xffdd00,
  cosmetic: 0x4488ff,
  none: 0x888888,
};
