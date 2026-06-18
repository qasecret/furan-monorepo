export interface BuildIdentity {
  name?: string | null;
  number?: number | null;
  ciBuildId?: string | null;
  id?: string | null;
}

/**
 * Build title precedence — the single source of truth for the Builds tab
 * row: name → #number → ciBuildId[:12] → uuid[:8] → "No build" (only when
 * there is no build at all).
 */
export function buildDisplayName(b: BuildIdentity): string {
  if (b.name) return b.name;
  if (b.number != null) return `#${b.number}`;
  if (b.ciBuildId) return b.ciBuildId.slice(0, 12);
  if (b.id) return b.id.slice(0, 8);
  return "No build";
}
