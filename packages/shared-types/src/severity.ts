import { z } from "zod";

/**
 * The one severity table. A diff region (and the worst region of a
 * checkpoint) carries one of these tiers; the diff engine assigns them and
 * the dashboard styles, sorts and filters by them. Listed worst first, so
 * array order and rank order agree.
 */
export const SEVERITIES = [
  "breaking",
  "major",
  "minor",
  "cosmetic",
  "none",
] as const;

export const severitySchema = z.enum(SEVERITIES);

export type Severity = z.infer<typeof severitySchema>;

const SEVERITY_RANK: Record<Severity, number> = {
  breaking: 4,
  major: 3,
  minor: 2,
  cosmetic: 1,
  none: 0,
};

/** Numeric rank for "most severe" comparisons; higher = worse. `none` = 0. */
export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/** Sort comparator, worst first: negative when `a` is worse than `b`. */
export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank(b) - severityRank(a);
}

/** The worst severity in `list`, or `null` when the list is empty. */
export function worstSeverity(list: readonly Severity[]): Severity | null {
  let worst: Severity | null = null;
  for (const s of list) {
    if (worst === null || severityRank(s) > severityRank(worst)) worst = s;
  }
  return worst;
}

export function isSeverity(x: unknown): x is Severity {
  return severitySchema.safeParse(x).success;
}

/** Display name of each tier. */
export const SEVERITY_LABEL: Record<Severity, string> = {
  breaking: "Breaking",
  major: "Major",
  minor: "Minor",
  cosmetic: "Cosmetic",
  none: "None",
};
