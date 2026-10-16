/**
 * The diff viewer's comparison modes (spec §4.1) and their form in the URL,
 * `?view` (§6.3). Pure and server-safe: the checkpoint page, a server
 * component, reads `?view` with `parseViewParam`, which it could not call
 * from a client module. The viewer's client modules re-export what they use
 * (`viewer-prefs`, `viewer-mode`).
 */

/** The comparison modes, in their order on the keys 1–5 and in `o`'s cycle. */
export const VIEWER_MODES = [
  "side-by-side",
  "swipe",
  "flicker",
  "overlay",
  "diff",
] as const;
export type ViewerMode = (typeof VIEWER_MODES)[number];

/** Each mode's name (spec §8): the toolbar's radio and its command's label. */
export const VIEWER_MODE_LABEL: Readonly<Record<ViewerMode, string>> = {
  "side-by-side": "Side by side",
  swipe: "Swipe",
  flicker: "Flicker",
  overlay: "Overlay",
  diff: "Diff",
};

/** Each mode's command (spec §4.1), the one its key and its radio run. */
export const VIEWER_MODE_COMMAND: Readonly<Record<ViewerMode, string>> = {
  "side-by-side": "viewer.mode.sideBySide",
  swipe: "viewer.mode.swipe",
  flicker: "viewer.mode.flicker",
  overlay: "viewer.mode.overlay",
  diff: "viewer.mode.diff",
};

/**
 * The mode a `?view` names, or null: an unknown value is ignored (spec
 * §6.3), and so is a repeated param, which names no one mode. Never throws.
 */
export function parseViewParam(
  v: string | string[] | undefined,
): ViewerMode | null {
  return typeof v === "string" &&
    (VIEWER_MODES as readonly string[]).includes(v)
    ? (v as ViewerMode)
    : null;
}
