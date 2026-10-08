/**
 * Reviewed mapping table for the token codemod (design-foundation spec §5.1).
 *
 * This table is a decision, not a heuristic: every light/dark pair below was
 * chosen by hand. Anything not listed here is left untouched and reported as
 * residue for the manual pass. Do not "complete" the table by guessing.
 *
 * Key format: `"<prop>:<light>|<dark>"`, colours written WITHOUT opacity, with
 * `prop` normalised by `lookupProperty` (`border-[xytrbl]` and `divide` →
 * `border`). The value is the semantic token name; the emitted class keeps the
 * ORIGINAL property (`border-l-edge`, `divide-edge`, `ring-offset-canvas`).
 */

/** Placeholder token resolved per variant chain by `hoverOrMuted`. */
export const HOVER_OR_MUTED = "HOVER_OR_MUTED";

type Entry = readonly [prop: string, pairs: readonly string[], token: string];

const ENTRIES: readonly Entry[] = [
  // text
  [
    "text",
    [
      "zinc-950|white",
      "zinc-900|white",
      "zinc-900|zinc-100",
      "zinc-800|zinc-100",
      "zinc-700|white",
      "zinc-800|zinc-200",
      "zinc-900|zinc-200",
    ],
    "fg",
  ],
  [
    "text",
    [
      "zinc-700|zinc-300",
      "zinc-600|zinc-400",
      "zinc-600|zinc-300",
      "zinc-700|zinc-200",
    ],
    "fg-secondary",
  ],
  [
    "text",
    [
      "zinc-500|zinc-400",
      "zinc-500|zinc-500",
      "zinc-600|zinc-500",
      "zinc-400|zinc-400",
    ],
    "fg-muted",
  ],
  // bg
  ["bg", ["white|black"], "canvas"],
  ["bg", ["white|zinc-950", "white|zinc-900"], "raised"],
  ["bg", ["zinc-50|black", "zinc-50|zinc-900", "zinc-50|zinc-950"], "sunken"],
  ["bg", ["zinc-100|zinc-900", "zinc-100|zinc-800"], HOVER_OR_MUTED],
  ["bg", ["zinc-200|zinc-800", "zinc-200|zinc-900"], "edge"],
  [
    "bg",
    ["zinc-200|zinc-700", "zinc-300|zinc-700", "zinc-300|zinc-800"],
    "edge-strong",
  ],
  // border (also border-x/y/t/r/b/l and divide, via lookupProperty)
  ["border", ["zinc-200|zinc-800", "zinc-200|zinc-900"], "edge"],
  ["border", ["zinc-100|zinc-900"], "edge-subtle"],
  [
    "border",
    [
      "zinc-300|zinc-700",
      "zinc-300|zinc-800",
      "zinc-300|zinc-600",
      "zinc-400|zinc-600",
    ],
    "edge-strong",
  ],
  // ring-offset
  ["ring-offset", ["white|zinc-950", "white|black"], "canvas"],
];

function buildPairMap(entries: readonly Entry[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const [prop, pairs, token] of entries) {
    for (const pair of pairs) {
      const key = `${prop}:${pair}`;
      // A duplicate key would mean one pair maps to two tokens: a table bug.
      if (map.has(key)) throw new Error(`codemod-tokens: duplicate key ${key}`);
      map.set(key, token);
    }
  }
  return map;
}

/** `"<prop>:<light>|<dark>"` → token (or `HOVER_OR_MUTED`). */
export const PAIR_MAP: ReadonlyMap<string, string> = buildPairMap(ENTRIES);

/**
 * Lone (unpaired) light classes with an unambiguous token. Applied only when
 * no surviving `dark:` text class shares the variant chain (see transform.ts).
 */
export const LONE_MAP: ReadonlyMap<string, string> = new Map([
  ["text:zinc-500", "fg-muted"],
]);

/** Hue family → status token. `emerald` and `green` are one family. */
export const HUE_STATUS: Readonly<Record<string, string>> = Object.freeze({
  red: "failed",
  amber: "unresolved",
  emerald: "passed",
  green: "passed",
  blue: "running",
  yellow: "aborted",
});

/** Interaction variants that make a `HOVER_OR_MUTED` pair resolve to `hover`. */
const HOVER_VARIANTS: ReadonlySet<string> = new Set([
  "hover",
  "focus",
  "focus-visible",
  "active",
  "group-hover",
  "aria-selected",
]);

/** `hover` for interaction / state chains, else `muted`. */
export function hoverOrMuted(variants: readonly string[]): "hover" | "muted" {
  return variants.some((v) => HOVER_VARIANTS.has(v) || v.startsWith("data-["))
    ? "hover"
    : "muted";
}

/** Normalise a colour property for table lookup only (output keeps the original). */
export function lookupProperty(property: string): string {
  return /^border-[xytrbl]$/.test(property) || property === "divide"
    ? "border"
    : property;
}
