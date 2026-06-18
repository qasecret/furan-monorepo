import { severityRank, type Severity } from "@furan/diff-engine";

export interface CheckpointSignatureInput {
  diffSignature: string | null;
  worstSeverity: Severity;
}

/**
 * A run's primary signature = the diff_signature of its most-severe UNRESOLVED
 * checkpoint (signature present AND at least one non-`none` region). Tie-break:
 * signature carried by the most unresolved checkpoints, then first-seen. Null
 * when none qualify. (ADR-043 §4.2.)
 */
export function computePrimarySignature(
  checkpoints: CheckpointSignatureInput[],
): string | null {
  const unresolved = checkpoints.filter(
    (c): c is { diffSignature: string; worstSeverity: Severity } =>
      c.diffSignature !== null && c.worstSeverity !== "none",
  );
  if (unresolved.length === 0) return null;

  const freq = new Map<string, number>();
  const order = new Map<string, number>();
  unresolved.forEach((c, i) => {
    freq.set(c.diffSignature, (freq.get(c.diffSignature) ?? 0) + 1);
    if (!order.has(c.diffSignature)) order.set(c.diffSignature, i);
  });
  const worstRank = new Map<string, number>();
  for (const c of unresolved) {
    const r = severityRank(c.worstSeverity);
    worstRank.set(
      c.diffSignature,
      Math.max(worstRank.get(c.diffSignature) ?? 0, r),
    );
  }

  let best: string | null = null;
  for (const sig of freq.keys()) {
    if (
      best === null ||
      worstRank.get(sig)! > worstRank.get(best)! ||
      (worstRank.get(sig)! === worstRank.get(best)! &&
        (freq.get(sig)! > freq.get(best)! ||
          (freq.get(sig)! === freq.get(best)! &&
            order.get(sig)! < order.get(best)!)))
    ) {
      best = sig;
    }
  }
  return best;
}
