"use client";

import type { RunStatus } from "@furan/shared-types";
import { Clock, GitBranch, Layers } from "lucide-react";

import { SetBreadcrumbs } from "@/app/(protected)/_components/set-breadcrumbs";
import { RunStatusBadge } from "@/components/run-status-badge";
import type { BreadcrumbCrumb } from "@/components/ui/breadcrumbs";
import { formatRelativeTime } from "@/lib/format";

interface Props {
  breadcrumb: BreadcrumbCrumb[];
  title: string;
  /** Optional pre-built status node. When omitted, falls back to a RunStatusBadge built from `status`. */
  statusNode?: React.ReactNode;
  /** Used as a fallback when `statusNode` is omitted. */
  status?: RunStatus;
  /** Metadata strip. Each defined entry renders a chip; undefined entries are skipped. */
  metadata?: {
    branch?: string | null;
    checkpointCount?: number | null;
    startedAt?: Date | string | null;
    completedAt?: Date | string | null;
  };
  /** Right-aligned slot for actions (compare-to picker, watch button, etc.). */
  rightActions?: React.ReactNode;
}

/**
 * Two-row contextual header rendered above the diff viewer. Row 1 = run title +
 * status; Row 2 = metadata chips. High information density, mono font for
 * machine values, lucide icons for visual rhythm.
 *
 * The breadcrumb trail it receives is published to the global TopBar trail (via
 * `<SetBreadcrumbs>`) rather than rendered inline, so the whole app shows one
 * breadcrumb in one place. Callers compose the breadcrumb (parents own routing
 * knowledge) and metadata (server-fetched run data); the component is otherwise
 * pure presentation.
 */
export function ContextualHeader({
  breadcrumb,
  title,
  statusNode,
  status,
  metadata,
  rightActions,
}: Props) {
  return (
    <header
      className="flex flex-col gap-2 border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950"
      data-testid="contextual-header"
    >
      <SetBreadcrumbs items={breadcrumb} />

      {/* Row 1: title · status — actions */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1
            className="truncate text-base font-semibold leading-tight text-zinc-900 dark:text-white md:text-lg"
            data-testid="contextual-header-title"
          >
            {title}
          </h1>
          {statusNode ?? (status ? <RunStatusBadge status={status} /> : null)}
        </div>
        {rightActions ? (
          <div className="flex shrink-0 items-center gap-2">{rightActions}</div>
        ) : null}
      </div>

      {/* Row 2: metadata chips */}
      {metadata ? <MetadataStrip {...metadata} /> : null}
    </header>
  );
}

function MetadataStrip({
  branch,
  checkpointCount,
  startedAt,
  completedAt,
}: NonNullable<Props["metadata"]>) {
  const startedDate = toDate(startedAt);
  const completedDate = toDate(completedAt);
  const startedLabel = startedDate ? formatRelativeTime(startedDate) : null;
  const durationLabel =
    startedDate && completedDate
      ? formatDuration(completedDate.getTime() - startedDate.getTime())
      : startedDate
        ? "in progress"
        : null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400"
      data-testid="contextual-header-meta"
    >
      {branch ? (
        <MetaItem icon={<GitBranch className="h-3.5 w-3.5" />}>
          <span className="font-mono text-zinc-700 dark:text-zinc-300">
            {branch}
          </span>
        </MetaItem>
      ) : null}
      {typeof checkpointCount === "number" ? (
        <MetaItem icon={<Layers className="h-3.5 w-3.5" />}>
          {checkpointCount} checkpoint{checkpointCount === 1 ? "" : "s"}
        </MetaItem>
      ) : null}
      {startedLabel ? (
        <MetaItem icon={<Clock className="h-3.5 w-3.5" />}>
          Started {startedLabel}
        </MetaItem>
      ) : null}
      {durationLabel ? <span>Duration: {durationLabel}</span> : null}
    </div>
  );
}

function MetaItem({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-zinc-400 dark:text-zinc-500" aria-hidden>
        {icon}
      </span>
      <span>{children}</span>
    </span>
  );
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const mrem = min % 60;
  return mrem ? `${hr}h ${mrem}m` : `${hr}h`;
}
