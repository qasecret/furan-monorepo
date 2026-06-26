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

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Absolute batch timestamp — "20 Nov 2024 at 7:23 PM" — for the batch-history
 * list, where a precise run time reads better than a relative "15h ago".
 * Manual format (not toLocale*) so it's deterministic across timezones/ICU.
 */
export function formatBatchDateTime(
  value: string | Date | null | undefined,
): string {
  if (value == null) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  const hours24 = d.getHours();
  const ampm = hours24 >= 12 ? "PM" : "AM";
  const hour12 = hours24 % 12 || 12;
  const minutes = d.getMinutes().toString().padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} at ${hour12}:${minutes} ${ampm}`;
}

/**
 * Duration as HH:MM:SS — e.g. 6 seconds → "00:00:06" — for the diff-viewer
 * execution panel (mirrors the Applitools/Pixelproof step "Batch duration").
 * Nullish / NaN / negative inputs clamp to "00:00:00".
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
