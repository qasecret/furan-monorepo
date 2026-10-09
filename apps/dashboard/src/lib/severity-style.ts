import type { Severity } from "@/components/diff-viewer/layers/regionTypes";

/**
 * The ONLY diff-region severity -> chip colour map in the dashboard. Its three
 * consumers all read from here, so a severity looks the same everywhere: the
 * diff viewer's region badges (RegionItem), the run header's aggregate pill
 * (AggregateSeverityPill) and the worst-severity stat in the viewer's info
 * sidebar (TestInfoSidebar).
 *
 * Severity isn't a run status, so it keeps its own hues rather than status
 * tokens (Ruling R18): an opaque pastel `-100` chip with `-800` text and a
 * `-300` border, the same in both themes with no `dark:` override. That is AA
 * on the chip itself (6.4–7.3:1) whatever surface sits behind it. The border
 * style varies too (cosmetic dashed, none dotted) so the meaning doesn't rest
 * on colour alone. `none` is neutral: there is no hue for "no severity".
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
  none: "border-edge border-dotted bg-hover text-fg-secondary",
} as const satisfies Record<Severity, string>;
