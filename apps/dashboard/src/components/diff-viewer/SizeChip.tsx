"use client";

interface Dims {
  width: number;
  height: number;
}
interface Props {
  baseline: Dims;
  candidate: Dims;
}

/**
 * Shows the image dimensions of the baseline + candidate. When the two
 * match (the common case) we render a single `1280×720` chip. When they
 * differ — a meaningful regression signal that's easy to miss in a
 * side-by-side pixel diff — we render both with a warning style and
 * highlight which dimension changed.
 */
export function SizeChip({ baseline, candidate }: Props) {
  const matches =
    baseline.width === candidate.width && baseline.height === candidate.height;

  if (matches) {
    return (
      <span
        className="inline-flex items-center rounded-md border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 font-mono tabular-nums dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
        data-testid="diff-viewer-size-chip"
      >
        {baseline.width}×{baseline.height}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs text-amber-900 font-mono tabular-nums dark:border-amber-500/40 dark:bg-amber-400/10 dark:text-amber-300"
      data-testid="diff-viewer-size-chip-mismatch"
      title="Baseline and candidate dimensions differ — this is a layout regression signal."
    >
      <span>
        {baseline.width}×{baseline.height}
      </span>
      <span className="text-amber-700 dark:text-amber-500">→</span>
      <span>
        {candidate.width}×{candidate.height}
      </span>
    </span>
  );
}
