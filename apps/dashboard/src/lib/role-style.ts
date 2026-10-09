import type { ViewerRole } from "@/lib/roles";

/**
 * The ONLY role -> chip colour map in the dashboard. The account menu's role
 * chip and the admin role badges both read from here, so a role looks the same
 * everywhere.
 *
 * Roles aren't run statuses, so they keep their own hues rather than status
 * tokens (Ruling R18): one opaque pastel `-100` chip with `-800` text serves
 * both themes with no `dark:` override. No single hue text shade reaches 4.5:1
 * on both a light and a dark surface, but `-800` on its own `-100` chip does
 * (amber 6.4, violet 7.7, sky 6.5) whatever sits behind the chip. Guest is
 * neutral: `fg-secondary` on `edge` (6.1 light / 5.9 dark), and `edge` stays
 * visible on the dark overlay where the `hover`/`muted` alias vanished.
 *
 * Every class is a full literal string: Tailwind's scanner cannot see class
 * names assembled at runtime. Typed by role, so a new tier is a compile error.
 */
export const ROLE_STYLE = {
  owner: "bg-amber-100 text-amber-800",
  admin: "bg-violet-100 text-violet-800",
  editor: "bg-sky-100 text-sky-800",
  guest: "bg-edge text-fg-secondary",
} as const satisfies Record<ViewerRole, string>;

/** Chip colours for a role string; anything unrecognised renders as guest. */
export function roleStyle(role: string): string {
  return Object.hasOwn(ROLE_STYLE, role)
    ? ROLE_STYLE[role as ViewerRole]
    : ROLE_STYLE.guest;
}
