export interface BuildIdentity {
  name?: string | null;
  /** The build's single distinct test name (set only for one-test builds). */
  testName?: string | null;
  number?: number | null;
  ciBuildId?: string | null;
  id?: string | null;
}

/**
 * Build title precedence — the single source of truth for the Builds tab
 * row: name (FURAN_BUILD_NAME) → single test name → #number →
 * ciBuildId[:12] → uuid[:8] → "No build" (only when there is no build at
 * all). The test-name tier lets a one-test build (the SDK's
 * one-test-per-build default, ADR-038) read as its test instead of an opaque
 * id, without the user setting FURAN_BUILD_NAME.
 */
export function buildDisplayName(b: BuildIdentity): string {
  if (b.name) return b.name;
  if (b.testName) return b.testName;
  if (b.number != null) return `#${b.number}`;
  if (b.ciBuildId) return b.ciBuildId.slice(0, 12);
  if (b.id) return b.id.slice(0, 8);
  return "No build";
}

/**
 * Whether a batch is found by the typed text (already trimmed): its display
 * name or its branch contains it, ignoring case. The one rule for the
 * Batches search box and the palette's Batches.
 */
export function matchesBatchSearch(
  b: BuildIdentity & { branchName?: string | null },
  query: string,
): boolean {
  const q = query.toLowerCase();
  return (
    buildDisplayName(b).toLowerCase().includes(q) ||
    (b.branchName ?? "").toLowerCase().includes(q)
  );
}
