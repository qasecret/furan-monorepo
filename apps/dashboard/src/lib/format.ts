/** Pluralization suffix: `plural(1)` -> "", otherwise "s". */
export const plural = (n: number): string => (n === 1 ? "" : "s");

/**
 * Relative-time formatter shared across the dashboard (inbox queue, run rows,
 * build groups, the diff-viewer header). Accepts an ISO string, a `Date`, or
 * nullish; returns "just now" / "Nm ago" / "Nh ago" / "Nd ago", falling back to
 * a locale date past 30 days.
 */
export function formatRelativeTime(
  value: string | Date | null | undefined,
): string {
  if (value == null) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}
