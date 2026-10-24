import type { CheckpointReviewState, RunStatus } from "@furan/shared-types";
import {
  BadgeCheck,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePlus,
  CircleX,
  LoaderCircle,
  type LucideIcon,
  ThumbsDown,
  TriangleAlert,
} from "lucide-react";

/**
 * The status -> presentation map for a run's status. Every surface that shows
 * a run/build status (badge, list rows, batch header, result rows, sparkline)
 * reads from here, so a status looks the same everywhere. A single
 * checkpoint's review state (approved and rejected steps included) has its own
 * map, `REVIEW_STATE_STYLE`, further down this file.
 *
 * Colours come from the `status-*` design tokens (`tokens.css`). Every class is
 * a full literal string: Tailwind's scanner cannot see class names assembled at
 * runtime, so never build these by interpolation (a test guards the source file).
 *
 * The unresolved/aborted split is load-bearing: `unresolved` (amber) means
 * "needs reviewer attention", `aborted` (yellow) means "infra issue - re-run".
 * `new` and `empty` are neutral: they carry no pass/fail signal.
 */
export interface StatusStyle {
  label: string;
  tooltip: string;
  icon: LucideIcon;
  /** `bg-*` for a status dot or a left accent bar. */
  dot: string;
  /** `fill-*` for SVG marks (sparkline points). */
  fill: string;
  /** `border-l-*` for a row's left accent. */
  accent: string;
  /** Status-word text colour (passes contrast on the page surfaces). */
  text: string;
  /** Tinted pill: border + background + text. */
  pill: string;
}

export const STATUS_STYLE = {
  new: {
    label: "New",
    tooltip: "First run for this test — baseline created",
    icon: CirclePlus,
    dot: "bg-status-neutral",
    fill: "fill-status-neutral",
    accent: "border-l-status-neutral",
    text: "text-status-neutral-text",
    pill: "border border-status-neutral/25 bg-status-neutral/10 text-status-neutral-text",
  },
  running: {
    label: "Running",
    tooltip: "Run is in progress",
    icon: LoaderCircle,
    dot: "bg-status-running",
    fill: "fill-status-running",
    accent: "border-l-status-running",
    text: "text-status-running-text",
    pill: "border border-status-running/25 bg-status-running/10 text-status-running-text",
  },
  passed: {
    label: "Passed",
    tooltip: "No visual differences",
    icon: CircleCheck,
    dot: "bg-status-passed",
    fill: "fill-status-passed",
    accent: "border-l-status-passed",
    text: "text-status-passed-text",
    pill: "border border-status-passed/25 bg-status-passed/10 text-status-passed-text",
  },
  unresolved: {
    label: "Unresolved",
    tooltip: "Visual differences found — awaiting review",
    icon: CircleAlert,
    dot: "bg-status-unresolved",
    fill: "fill-status-unresolved",
    accent: "border-l-status-unresolved",
    text: "text-status-unresolved-text",
    pill: "border border-status-unresolved/25 bg-status-unresolved/10 text-status-unresolved-text",
  },
  failed: {
    label: "Failed",
    tooltip: "Differences rejected",
    icon: CircleX,
    dot: "bg-status-failed",
    fill: "fill-status-failed",
    accent: "border-l-status-failed",
    text: "text-status-failed-text",
    pill: "border border-status-failed/25 bg-status-failed/10 text-status-failed-text",
  },
  aborted: {
    label: "Aborted",
    tooltip: "Run terminated before completion (worker issue)",
    icon: Ban,
    dot: "bg-status-aborted",
    fill: "fill-status-aborted",
    accent: "border-l-status-aborted",
    text: "text-status-aborted-text",
    pill: "border border-status-aborted/25 bg-status-aborted/10 text-status-aborted-text",
  },
  empty: {
    label: "Empty",
    tooltip: "Run completed but recorded no checks",
    icon: CircleDashed,
    dot: "bg-status-neutral",
    fill: "fill-status-neutral",
    accent: "border-l-status-neutral",
    text: "text-status-neutral-text",
    pill: "border border-status-neutral/25 bg-status-neutral/10 text-status-neutral-text",
  },
} as const satisfies Record<RunStatus, StatusStyle>;

/** Style for a status string; anything unrecognised renders as `empty`. */
export function statusStyle(status: string): StatusStyle {
  return Object.hasOwn(STATUS_STYLE, status)
    ? STATUS_STYLE[status as RunStatus]
    : STATUS_STYLE.empty;
}

/**
 * Per-checkpoint review state. A reviewer's decision replaces the diff verdict,
 * so `approved` keeps the `passed` colours and `rejected` keeps the `failed`
 * colours, each with its own icon, label and tooltip.
 */
export const REVIEW_STATE_STYLE = {
  new: STATUS_STYLE.new,
  passed: STATUS_STYLE.passed,
  unresolved: STATUS_STYLE.unresolved,
  approved: {
    ...STATUS_STYLE.passed,
    icon: BadgeCheck,
    label: "Approved",
    tooltip: "Approved by a reviewer",
  },
  rejected: {
    ...STATUS_STYLE.failed,
    icon: ThumbsDown,
    label: "Rejected",
    tooltip: "Rejected by a reviewer",
  },
} as const satisfies Record<CheckpointReviewState, StatusStyle>;

/**
 * A step whose diff failed for good (spec 2026-10-23 §10): it has no result,
 * so it is no review state, and it never changes the run's own status. It
 * reads in the danger tone with its own icon, apart from a rejected step.
 */
export const DIFF_FAILED_STYLE = {
  label: "Diff failed",
  tooltip: "The diff failed; no result yet",
  icon: TriangleAlert,
  dot: "bg-status-failed",
  fill: "fill-status-failed",
  accent: "border-l-status-failed",
  text: "text-status-failed-text",
  pill: "border border-status-failed/25 bg-status-failed/10 text-status-failed-text",
} as const satisfies StatusStyle;

/** Style for a review state; anything unrecognised renders as `empty`. */
export function reviewStateStyle(state: string): StatusStyle {
  return Object.hasOwn(REVIEW_STATE_STYLE, state)
    ? REVIEW_STATE_STYLE[state as CheckpointReviewState]
    : STATUS_STYLE.empty;
}
