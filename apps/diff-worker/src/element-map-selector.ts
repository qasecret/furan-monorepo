/// <reference lib="dom" />

const SIMPLE_IDENT = /^[a-zA-Z0-9_-]+$/;

/**
 * Lightweight CSS.escape-compatible escape for id segment values.
 * The Kotlin SDK's ElementBboxScript.kt calls `CSS.escape(el.id)`
 * before writing the `#${id}` key to the element-map. To match, we
 * escape any character outside the SIMPLE_IDENT range — covers the
 * realistic cases (colons in Tailwind-style ids, dots in
 * dot-namespaced ids, spaces in malformed-but-present ids).
 *
 * This is NOT a full WHATWG CSS.escape (no surrogate pair handling,
 * no NULL handling, no leading-digit handling). It IS sufficient
 * for the element-map round-trip because the SDK script only ever
 * runs CSS.escape on id strings it just read from the DOM — those
 * strings have already passed through HTML parsing.
 */
function cssEscapeIdent(s: string): string {
  // Escape every char that's not in SIMPLE_IDENT.
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/**
 * Build one SDK-format path segment for a real DOM Element node
 * (jsdom or a real browser DOM). Matches the SDK's cssPath()
 * algorithm in packages/sdk-kotlin/.../ElementBboxScript.kt:
 *
 *   - If the node has an `id`, return `#${id}` (caller treats this as
 *     a path-root reset — the SDK selector chain stops at the nearest
 *     #id ancestor).
 *   - Else `${tag}` + `.${cls1}.${cls2}...` (all classes whose names
 *     pass the SDK's `/^[a-zA-Z0-9_-]+$/` identifier filter).
 *   - Append `:nth-child(N)` (1-based, among ALL parent children — NOT
 *     just same-tag) ONLY when 2+ siblings share the same tag.
 *
 * Returns null when the node has no usable tag (defensive — callers
 * are expected to pass real Element nodes).
 *
 * Used by the axe bbox resolver. NOT used by the L2 resolver, which
 * walks a diff-dom AST (different node shape).
 */
export function elementSegment(node: Element): string | null {
  const tag = node.tagName?.toLowerCase();
  if (!tag) return null;
  if (node.id) return `#${cssEscapeIdent(node.id)}`;
  let part = tag;
  const classes = Array.from(node.classList).filter((c) =>
    SIMPLE_IDENT.test(c),
  );
  if (classes.length > 0) part += "." + classes.join(".");
  const parent = node.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children);
    let sameTag = 0;
    for (const s of siblings) {
      if (s.tagName?.toLowerCase() === tag) sameTag++;
    }
    if (sameTag > 1) {
      const idx = siblings.indexOf(node);
      if (idx >= 0) part += `:nth-child(${idx + 1})`;
    }
  }
  return part;
}

/**
 * Build the list of SDK-format selectors for `node` and every ancestor
 * up to (and including) the nearest #id ancestor (or root if no id).
 * Returns root → leaf order: the LAST element is the leaf's own SDK
 * selector; earlier elements are progressively closer ancestors.
 *
 * Used by the axe bbox resolver: it walks LEAF → ROOT (iterating
 * the array in reverse) looking for the smallest matching ancestor
 * in the element-map.
 */
export function buildSdkSelectorFromAncestors(leaf: Element): string[] {
  const chain: Element[] = [];
  let cursor: Element | null = leaf;
  while (cursor) {
    chain.push(cursor);
    if (cursor.id) break;
    cursor = cursor.parentElement;
  }
  // chain is leaf → root; reverse to root → leaf for selector building.
  chain.reverse();
  const segments: string[] = [];
  const results: string[] = [];
  for (const el of chain) {
    const seg = elementSegment(el);
    if (!seg) continue;
    if (seg.startsWith("#")) {
      segments.length = 0;
      segments.push(seg);
    } else {
      segments.push(seg);
    }
    results.push(segments.join(" > "));
  }
  return results;
}
