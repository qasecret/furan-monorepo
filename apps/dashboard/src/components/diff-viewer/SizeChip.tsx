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
        className="inline-flex items-center rounded-md border border-edge bg-hover px-2 py-0.5 text-xs text-fg-secondary font-mono tabular-nums"
        data-testid="diff-viewer-size-chip"
      >
        {baseline.width}×{baseline.height}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs text-amber-800 font-mono tabular-nums"
      data-testid="diff-viewer-size-chip-mismatch"
      title="Baseline and candidate dimensions differ — this is a layout regression signal."
    >
      <span>
        {baseline.width}×{baseline.height}
      </span>
      <span className="text-amber-700">→</span>
      <span>
        {candidate.width}×{candidate.height}
      </span>
    </span>
  );
}
