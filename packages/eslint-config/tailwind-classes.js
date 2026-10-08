// @ts-check
//
// Shared Tailwind colour-class grammar.
//
// Consumed by the `@furan/no-raw-palette` lint rule and by the dashboard
// token codemod, so both agree on what counts as a "colour class". This module
// is pure string handling: no ESLint, no AST, no Tailwind runtime.

/**
 * @typedef {object} ParsedClass
 * @property {string} raw The original token, exactly as written.
 * @property {string[]} variants Variants in source order (`dark`, `hover`, `data-[state=open]`).
 * @property {string} property The colour-bearing utility prefix (`bg`, `border-l`, `ring-offset`, ...).
 * @property {string} value The colour: `zinc-900`, `white`, `status-failed`, or raw bracket text such as `[#09090b]`.
 * @property {string | null} opacity The text after a trailing `/` outside brackets, or null.
 * @property {boolean} important Whether a `!` was stripped from either end of the utility.
 */

/**
 * Utility prefixes that take a colour. Matching is longest-first, so
 * `ring-offset-white` is `ring-offset` and not `ring`. `placeholder:` is a
 * variant in Tailwind, not a property, so it is deliberately absent.
 *
 * @type {readonly string[]}
 */
export const COLOR_PROPERTIES = Object.freeze([
  "border-x",
  "border-y",
  "border-t",
  "border-r",
  "border-b",
  "border-l",
  "ring-offset",
  "decoration",
  "outline",
  "divide",
  "stroke",
  "shadow",
  "caret",
  "accent",
  "border",
  "ring",
  "fill",
  "from",
  "via",
  "bg",
  "text",
  "to",
]);

/** @type {readonly ["zinc", "gray", "slate", "neutral", "stone"]} */
export const NEUTRAL_PALETTES = Object.freeze(
  /** @type {const} */ (["zinc", "gray", "slate", "neutral", "stone"]),
);

/** The 22 Tailwind v4 palette names. */
const PALETTE_NAMES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

const PALETTE_RE = new RegExp(
  `^(?:${PALETTE_NAMES.join("|")})-(?:50|[1-9]00|950)$`,
);

const NEUTRAL_RE = new RegExp(`^(?:${NEUTRAL_PALETTES.join("|")})-\\d{2,3}$`);

const COLOR_KEYWORDS = new Set([
  "white",
  "black",
  "transparent",
  "current",
  "inherit",
]);

/** Semantic design tokens (Task 1) plus the shadcn-style alias names. */
const TOKEN_NAMES = new Set([
  "canvas",
  "sunken",
  "raised",
  "overlay",
  "hover",
  "edge",
  "edge-subtle",
  "edge-strong",
  "fg",
  "fg-secondary",
  "fg-muted",
  "brand",
  "brand-fg",
  "brand-text",
  "ring",
  "status-passed",
  "status-passed-text",
  "status-unresolved",
  "status-unresolved-text",
  "status-failed",
  "status-failed-text",
  "status-running",
  "status-running-text",
  "status-aborted",
  "status-aborted-text",
  "status-neutral",
  "status-neutral-text",
  // Aliases.
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
]);

/** Colour functions / hex marker that make a `[...]` value a colour. */
const ARBITRARY_COLOR_RE = /#|rgba?\(|hsla?\(|oklch\(/i;

/** `text-[11px]`, `text-[0.7rem]`, `text-[1.25em]`. */
const ARBITRARY_FONT_SIZE_RE = /^text-\[(?:\d+\.?\d*|\.\d+)(?:px|rem|em)\]$/;

/** Properties sorted longest-first for prefix matching. */
const PROPERTIES_LONGEST_FIRST = [...COLOR_PROPERTIES].sort(
  (a, b) => b.length - a.length,
);

/**
 * Index of the last `sep` at bracket depth 0, or -1.
 *
 * @param {string} s
 * @param {string} sep
 * @returns {number}
 */
function lastTopLevelIndex(s, sep) {
  let depth = 0;
  let found = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) found = i;
  }
  return found;
}

/**
 * Split a token into variants and the utility, ignoring `:` inside `[...]`.
 * A `!` is stripped from either end of the utility.
 *
 * @param {string} token
 * @returns {{ variants: string[]; utility: string; important: boolean }}
 */
function splitToken(token) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  let utility = token.slice(start);

  let important = false;
  if (utility.startsWith("!")) {
    important = true;
    utility = utility.slice(1);
  }
  if (utility.endsWith("!")) {
    important = true;
    utility = utility.slice(0, -1);
  }
  return { variants: parts, utility, important };
}

/**
 * Whether `property` + bracket `value` is an arbitrary colour. Shadow values
 * are excluded: a `shadow-[...]` is a box-shadow, never a bare colour.
 *
 * @param {string} property
 * @param {string} value
 * @returns {boolean}
 */
function isArbitraryColorValue(property, value) {
  if (property === "shadow") return false;
  if (!value.startsWith("[") || !value.endsWith("]")) return false;
  return ARBITRARY_COLOR_RE.test(value);
}

/**
 * Whether `value` is a colour for the given property.
 *
 * @param {string} property
 * @param {string} value
 * @returns {boolean}
 */
function isColorValue(property, value) {
  if (value === "") return false;
  if (value.startsWith("[")) return isArbitraryColorValue(property, value);
  return (
    PALETTE_RE.test(value) ||
    COLOR_KEYWORDS.has(value) ||
    TOKEN_NAMES.has(value)
  );
}

/**
 * Structural parse: split a token into variants / property / value / opacity
 * without deciding whether the value is a colour. Null when no colour
 * property prefix matches.
 *
 * @param {string} token
 * @returns {ParsedClass | null}
 */
function parseStructure(token) {
  const { variants, utility, important } = splitToken(token);

  const property = PROPERTIES_LONGEST_FIRST.find((p) =>
    utility.startsWith(`${p}-`),
  );
  if (property === undefined) return null;

  let value = utility.slice(property.length + 1);
  /** @type {string | null} */
  let opacity = null;
  const slash = lastTopLevelIndex(value, "/");
  if (slash !== -1) {
    const rest = value.slice(slash + 1);
    value = value.slice(0, slash);
    opacity = rest === "" ? null : rest;
  }

  return { raw: token, variants, property, value, opacity, important };
}

/**
 * Split a class attribute / string into tokens: whitespace split, empties dropped.
 *
 * @param {string} s
 * @returns {string[]}
 */
export function splitClasses(s) {
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Parse one class token. Returns null unless its property is one of
 * `COLOR_PROPERTIES` and its value is a colour (so `text-sm`, `border-2`,
 * `bg-gradient-to-r`, `shadow-lg` and friends are all null).
 *
 * @param {string} token
 * @returns {ParsedClass | null}
 */
export function parseClass(token) {
  const parsed = parseStructure(token);
  if (parsed === null) return null;
  return isColorValue(parsed.property, parsed.value) ? parsed : null;
}

/**
 * Whether a parsed class uses a neutral Tailwind palette (`zinc-900`, ...).
 *
 * @param {ParsedClass} p
 * @returns {boolean}
 */
export function isNeutral(p) {
  return NEUTRAL_RE.test(p.value);
}

/**
 * Whether a token is a colour utility with an arbitrary colour value, such as
 * `bg-[#09090b]` or `text-[rgb(1,2,3)]`. `shadow-[...]` never counts.
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isArbitraryColor(token) {
  const parsed = parseStructure(token);
  if (parsed === null) return false;
  return isArbitraryColorValue(parsed.property, parsed.value);
}

/**
 * Whether a token is an arbitrary font size: `text-[<number>(px|rem|em)]`.
 * A trailing `/line-height` is ignored.
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isArbitraryFontSize(token) {
  let { utility } = splitToken(token);
  const slash = lastTopLevelIndex(utility, "/");
  if (slash !== -1) utility = utility.slice(0, slash);
  return ARBITRARY_FONT_SIZE_RE.test(utility);
}
