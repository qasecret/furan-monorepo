export interface ParsedClass {
  /** The original token, exactly as written. */
  raw: string;
  /** Variants in source order, e.g. `["dark", "hover"]`. */
  variants: string[];
  /** The colour-bearing utility prefix: `bg`, `border-l`, `ring-offset`, ... */
  property: string;
  /** `zinc-900`, `white`, `status-failed`, or raw bracket text like `[#09090b]`. */
  value: string;
  /** Text after a trailing `/` outside brackets, or null. */
  opacity: string | null;
  /** Whether a `!` was stripped from either end of the utility. */
  important: boolean;
}

/** Colour-bearing utility prefixes (matched longest-first). */
export const COLOR_PROPERTIES: readonly string[];

export const NEUTRAL_PALETTES: readonly [
  "zinc",
  "gray",
  "slate",
  "neutral",
  "stone",
];

/** Whitespace split, empty strings dropped. */
export function splitClasses(s: string): string[];

/** Null unless the property is in COLOR_PROPERTIES and the value is a colour. */
export function parseClass(token: string): ParsedClass | null;

/** Value matches `^(zinc|gray|slate|neutral|stone)-\d{2,3}$`. */
export function isNeutral(p: ParsedClass): boolean;

/** A colour property (not shadow) with an arbitrary `[...]` colour value. */
export function isArbitraryColor(token: string): boolean;

/** `text-[<number>(px|rem|em)]`. */
export function isArbitraryFontSize(token: string): boolean;
