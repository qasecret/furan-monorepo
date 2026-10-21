/**
 * Nearest-rank percentile of an ascending array: `sorted[ceil(p/100 * n) - 1]`.
 * `p * n` is multiplied out before dividing, so exact multiples stay exact
 * instead of picking up floating-point error from `p / 100`.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) throw new Error("percentile of an empty array");
  if (!(p >= 0 && p <= 100)) {
    throw new RangeError(`percentile must be within 0..100, got ${p}`);
  }
  const rank = Math.min(n, Math.max(1, Math.ceil((p * n) / 100)));
  return sortedAsc[rank - 1] as number;
}

/**
 * Events per consecutive window of `windowMs`, the first window starting at the
 * earliest timestamp. Windows are half-open (`[start, start + windowMs)`), and
 * a window with no events between two that have some counts as zero.
 */
export function windowCounts(
  timestampsMs: readonly number[],
  windowMs: number,
): number[] {
  if (!(windowMs > 0)) {
    throw new RangeError(`windowMs must be positive, got ${windowMs}`);
  }
  if (timestampsMs.length === 0) return [];
  // A loop, not Math.min(...spread): a long event log must not blow the argument limit.
  let start = Infinity;
  for (const t of timestampsMs) if (t < start) start = t;
  const counts: number[] = [];
  for (const t of timestampsMs) {
    const index = Math.floor((t - start) / windowMs);
    while (counts.length <= index) counts.push(0);
    counts[index] = (counts[index] as number) + 1;
  }
  return counts;
}
