/**
 * Token codemod core (design-foundation spec §5.1): rewrite light/`dark:`
 * colour-class pairs into semantic token classes using the reviewed table in
 * `map.ts`, and report everything it cannot map safely as residue.
 *
 * Invariants:
 * - Never guess: a pair or class that the table / hue / lone rules do not
 *   cover is left exactly as written and reported.
 * - Never half-convert: a pair is only rewritten when BOTH halves sit in the
 *   same string; a lone `text-zinc-500` is only rewritten when no surviving
 *   `dark:` text class with the same variant chain exists anywhere in the same
 *   class expression (sibling strings in one `cn(...)` / `cva(...)` / template).
 * - Idempotent: the output contains no class the rules can rewrite again.
 */
import {
  isNeutral,
  parseClass,
  splitClasses,
  type ParsedClass,
} from "@furan/eslint-config/tailwind-classes.js";
import ts from "typescript";

import {
  HOVER_OR_MUTED,
  HUE_STATUS,
  LONE_MAP,
  PAIR_MAP,
  hoverOrMuted,
  lookupProperty,
} from "./map";

export interface Residue {
  line: number;
  cls: string;
  reason: "unmapped" | "dynamic";
}

/** One whitespace-separated token of a class string. */
interface Token {
  text: string;
  /** Offset of the token inside the class string. */
  start: number;
  /** Abuts a `${}` boundary, so the runtime class is unknown. */
  cut: boolean;
  /** Parsed colour class, or null (non-colour, or cut). */
  parsed: ParsedClass | null;
}

interface PieceOptions {
  /** The string starts right after a `${}` (template middle / tail). */
  cutStart?: boolean;
  /** The string ends right before a `${` (template head / middle). */
  cutEnd?: boolean;
  /** `darkKey`s of surviving `dark:` classes in sibling strings. */
  loneBlocked?: ReadonlySet<string>;
}

interface PieceResult {
  out: string;
  changed: boolean;
  residue: { cls: string; reason: Residue["reason"]; offset: number }[];
  /** `darkKey`s of `dark:` colour classes left in `out` (`*` = unknown). */
  survivingDark: string[];
}

/** Palette shades and white / black: the only values the rules can map. */
const RAW_COLOUR_RE = /^(?:[a-z]+-\d{2,3}|white|black)$/;

/** Wildcard `darkKey` for a `dark:` fragment whose utility is dynamic. */
const ANY = "*";

function isDark(p: ParsedClass): boolean {
  return p.variants.includes("dark");
}

function isRawColour(p: ParsedClass | null): p is ParsedClass {
  return p !== null && RAW_COLOUR_RE.test(p.value);
}

/** The variant chain without `dark`, as a comparable key. */
function chainKey(p: ParsedClass): string {
  return p.variants.filter((v) => v !== "dark").join("\u0000");
}

/** Property + chain key: what a lone class and a `dark:` class must share to collide. */
function darkKey(p: ParsedClass): string {
  return `${p.property}\u0001${chainKey(p)}`;
}

/** Where the author put the `!`, if anywhere. */
function bang(p: ParsedClass): "" | "prefix" | "suffix" {
  if (!p.important) return "";
  return p.raw.endsWith("!") ? "suffix" : "prefix";
}

function formatClass(
  light: ParsedClass,
  token: string,
  opacity: string | null,
  important: "" | "prefix" | "suffix",
): string {
  const chain = light.variants.map((v) => `${v}:`).join("");
  const utility = `${light.property}-${token}${opacity === null ? "" : `/${opacity}`}`;
  if (important === "prefix") return `${chain}!${utility}`;
  if (important === "suffix") return `${chain}${utility}!`;
  return `${chain}${utility}`;
}

/**
 * Opacity modifier as a percentage: undefined when absent, NaN when it can't
 * be read statically (`/(--x)`, `/[var(--a)]`).
 */
function opacityPercent(opacity: string | null): number | undefined {
  if (opacity === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(opacity)) return Number(opacity);
  const pct = /^\[(\d+(?:\.\d+)?)%\]$/.exec(opacity);
  if (pct) return Number(pct[1]);
  const frac = /^\[(\d*\.?\d+)\]$/.exec(opacity);
  if (frac) {
    const n = Number(frac[1]);
    return n <= 1 ? n * 100 : Number.NaN;
  }
  return Number.NaN;
}

function hueOf(value: string): { family: string; shade: number } | null {
  const m = /^([a-z]+)-(\d{2,3})$/.exec(value);
  if (!m) return null;
  return { family: m[1] ?? "", shade: Number(m[2]) };
}

/** Hue-pair rule: both sides chromatic, same status family. */
function hueToken(
  light: ParsedClass,
  dark: ParsedClass,
  lookupProp: string,
): { token: string; opacity: string | null } | null {
  const a = hueOf(light.value);
  const b = hueOf(dark.value);
  if (!a || !b) return null;
  const status = HUE_STATUS[a.family];
  if (status === undefined || HUE_STATUS[b.family] !== status) return null;

  if (lookupProp === "text") {
    return { token: `status-${status}-text`, opacity: null };
  }
  if (lookupProp === "border") {
    return { token: `status-${status}`, opacity: "25" };
  }
  if (lookupProp === "bg") {
    const tint = { token: `status-${status}`, opacity: "10" };
    if (a.shade <= 200) return tint;
    const opacities = [
      opacityPercent(light.opacity),
      opacityPercent(dark.opacity),
    ];
    if (opacities.some((o) => o !== undefined && o <= 20)) return tint;
    // An opacity we can't read could have been ≤ 20: don't guess.
    if (opacities.some((o) => o !== undefined && Number.isNaN(o))) return null;
    return { token: `status-${status}`, opacity: null };
  }
  return null;
}

/** Table lookup, then the hue rule. Null on a miss. */
function mapPair(light: ParsedClass, dark: ParsedClass): string | null {
  const lookupProp = lookupProperty(light.property);
  let token = PAIR_MAP.get(`${lookupProp}:${light.value}|${dark.value}`);
  let opacity = light.opacity;
  if (token === HOVER_OR_MUTED) token = hoverOrMuted(light.variants);
  if (token === undefined) {
    const hue = hueToken(light, dark, lookupProp);
    if (hue === null) return null;
    token = hue.token;
    opacity = hue.opacity;
  }
  return formatClass(light, token, opacity, bang(light) || bang(dark));
}

/** Whether a token cut by `${}` is (or may become) a `dark:` / neutral class. */
function looksDarkOrNeutral(fragment: string): boolean {
  const parsed = parseClass(fragment);
  if (parsed !== null) return isNeutral(parsed) || isDark(parsed);
  if (/(?:^|:)dark:/.test(fragment)) return true;
  return (
    /(?:^|[-:!])(?:zinc|gray|slate|stone|neutral)(?:-|$)/.test(fragment) &&
    !/status-neutral/.test(fragment)
  );
}

function tokenize(s: string, opts: PieceOptions): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  for (const text of splitClasses(s)) {
    const start = s.indexOf(text, cursor);
    cursor = start + text.length;
    tokens.push({ text, start, cut: false, parsed: null });
  }
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (opts.cutStart && first && first.start === 0) first.cut = true;
  if (opts.cutEnd && last && last.start + last.text.length === s.length) {
    last.cut = true;
  }
  for (const t of tokens) t.parsed = t.cut ? null : parseClass(t.text);
  return tokens;
}

/** Transform one class string (a string literal or one template part). */
function transformPiece(s: string, opts: PieceOptions = {}): PieceResult {
  const tokens = tokenize(s, opts);
  const replacement = new Map<number, string>();
  const dropped = new Set<number>();
  const used = new Set<number>();
  const residue = new Map<number, Residue["reason"]>();

  // 1. Pairs: light class A + first unused `dark:` B with the same original
  //    property and the same variant chain (minus `dark`).
  tokens.forEach((a, i) => {
    const pa = a.parsed;
    if (!isRawColour(pa) || isDark(pa)) return;
    const j = tokens.findIndex(
      (b, k) =>
        k !== i &&
        !used.has(k) &&
        isRawColour(b.parsed) &&
        isDark(b.parsed) &&
        b.parsed.property === pa.property &&
        chainKey(b.parsed) === chainKey(pa),
    );
    const pb = tokens[j]?.parsed;
    if (j === -1 || !pb) return;
    used.add(i);
    used.add(j);
    const out = mapPair(pa, pb);
    if (out === null) {
      residue.set(i, "unmapped");
      residue.set(j, "unmapped");
    } else {
      replacement.set(i, out);
      dropped.add(j);
    }
  });

  // 2. `dark:` colour classes that survive into the output.
  const survivingDark = new Set<string>();
  tokens.forEach((t, k) => {
    if (dropped.has(k)) return;
    const p = parseClass(t.text);
    if (p !== null && isDark(p)) survivingDark.add(darkKey(p));
    else if (p === null && t.cut && /(?:^|:)dark:/.test(t.text)) {
      survivingDark.add(ANY);
    }
  });

  // 3. Lone classes, only when no surviving dark class could pair with them.
  const blocked = (key: string): boolean =>
    survivingDark.has(key) ||
    survivingDark.has(ANY) ||
    (opts.loneBlocked?.has(key) ?? false) ||
    (opts.loneBlocked?.has(ANY) ?? false);
  tokens.forEach((a, i) => {
    const pa = a.parsed;
    if (used.has(i) || pa === null || isDark(pa)) return;
    const token = LONE_MAP.get(`${pa.property}:${pa.value}`);
    if (token === undefined || blocked(darkKey(pa))) return;
    replacement.set(i, formatClass(pa, token, pa.opacity, bang(pa)));
  });

  // 4. Residue: neutral and `dark:` colour classes left unchanged.
  tokens.forEach((t, k) => {
    if (replacement.has(k) || dropped.has(k) || residue.has(k)) return;
    if (t.cut) {
      if (looksDarkOrNeutral(t.text)) residue.set(k, "dynamic");
      return;
    }
    const p = t.parsed;
    if (p !== null && (isNeutral(p) || isDark(p))) residue.set(k, "unmapped");
  });

  const changed = replacement.size > 0 || dropped.size > 0;
  let out = s;
  if (changed) {
    const lead = /^\s*/.exec(s)?.[0] ?? "";
    const trail = /\s*$/.exec(s)?.[0] ?? "";
    const body = tokens
      .flatMap((t, k) => (dropped.has(k) ? [] : [replacement.get(k) ?? t.text]))
      .join(" ");
    out = `${lead}${body}${trail}`;
  }

  const residueList: PieceResult["residue"] = [];
  tokens.forEach((t, k) => {
    const reason = residue.get(k);
    if (reason) residueList.push({ cls: t.text, reason, offset: t.start });
  });

  return {
    out,
    changed,
    residue: residueList,
    survivingDark: [...survivingDark],
  };
}

/** Transform one class string. Unchanged strings are returned verbatim. */
export function transformClassString(s: string): {
  out: string;
  residue: string[];
} {
  const r = transformPiece(s);
  return { out: r.out, residue: r.residue.map((x) => x.cls) };
}

// ---------------------------------------------------------------------------
// Source files
// ---------------------------------------------------------------------------

interface Piece {
  /** Content range inside the source (quotes / `${` / `}` excluded). */
  start: number;
  end: number;
  opts: PieceOptions;
  /** Outermost class expression the string belongs to (see `scopeRoot`). */
  root: ts.Node;
}

/**
 * Expression kinds through which sibling strings combine into one class list
 * at runtime: `cn(a, b && c)`, `cva(base, { variants })`, templates, arrays.
 */
const CONTAINER_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.TaggedTemplateExpression,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.TemplateSpan,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.SpreadElement,
  ts.SyntaxKind.SpreadAssignment,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.JsxExpression,
]);

function scopeRoot(node: ts.Node): ts.Node {
  let cur = node;
  while (cur.parent !== undefined && CONTAINER_KINDS.has(cur.parent.kind)) {
    cur = cur.parent;
  }
  return cur;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const p = node.parent;
  if (p === undefined) return false;
  return (
    (ts.isImportDeclaration(p) && p.moduleSpecifier === node) ||
    (ts.isExportDeclaration(p) && p.moduleSpecifier === node) ||
    (ts.isExternalModuleReference(p) && p.expression === node) ||
    (ts.isCallExpression(p) &&
      p.expression.kind === ts.SyntaxKind.ImportKeyword) ||
    (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent))
  );
}

function toPiece(node: ts.Node, sf: ts.SourceFile): Piece | null {
  const start = node.getStart(sf);
  const end = node.getEnd();
  const root = scopeRoot(node);
  switch (node.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return { start: start + 1, end: end - 1, opts: {}, root };
    case ts.SyntaxKind.TemplateHead: // `…${
      return { start: start + 1, end: end - 2, opts: { cutEnd: true }, root };
    case ts.SyntaxKind.TemplateMiddle: // }…${
      return {
        start: start + 1,
        end: end - 2,
        opts: { cutStart: true, cutEnd: true },
        root,
      };
    case ts.SyntaxKind.TemplateTail: // }…`
      return { start: start + 1, end: end - 1, opts: { cutStart: true }, root };
    default:
      return null;
  }
}

function scriptKind(fileName: string): ts.ScriptKind {
  // `.ts` files are parsed as TS so `<T>x` assertions and `<T>() =>` generics
  // aren't misread as JSX; everything else as TSX.
  return /\.[cm]?ts$/.test(fileName) && !fileName.endsWith(".d.ts")
    ? ts.ScriptKind.TS
    : ts.ScriptKind.TSX;
}

/** Transform every string / template part in a TS or TSX source file. */
export function transformSource(
  src: string,
  fileName: string,
): { out: string; residue: Residue[] } {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );

  const pieces: Piece[] = [];
  const visit = (node: ts.Node): void => {
    if (isModuleSpecifier(node)) return;
    const piece = toPiece(node, sf);
    if (piece !== null) pieces.push(piece);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Pass 1: which dark classes survive in each class expression. A lone
  // rewrite is blocked if a sibling string keeps a dark partner for it.
  const survivingByRoot = new Map<ts.Node, Set<string>>();
  for (const p of pieces) {
    const r = transformPiece(src.slice(p.start, p.end), p.opts);
    let set = survivingByRoot.get(p.root);
    if (set === undefined) {
      set = new Set();
      survivingByRoot.set(p.root, set);
    }
    for (const key of r.survivingDark) set.add(key);
  }

  // Pass 2: transform with the scope-wide block list.
  const edits: { start: number; end: number; text: string }[] = [];
  const found: (Residue & { pos: number })[] = [];
  for (const p of pieces) {
    const r = transformPiece(src.slice(p.start, p.end), {
      ...p.opts,
      loneBlocked: survivingByRoot.get(p.root),
    });
    if (r.changed) edits.push({ start: p.start, end: p.end, text: r.out });
    for (const x of r.residue) {
      const pos = p.start + x.offset;
      found.push({
        line: sf.getLineAndCharacterOfPosition(pos).line + 1,
        cls: x.cls,
        reason: x.reason,
        pos,
      });
    }
  }

  // Apply edits end → start so earlier offsets stay valid.
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  const residue = found
    .sort((a, b) => a.pos - b.pos)
    .map(({ line, cls, reason }) => ({ line, cls, reason }));
  return { out, residue };
}
