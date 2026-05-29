"use client";

import type { RunStatus } from "@furan/shared-types";
import { ChevronRight, Clock, GitBranch, Layers } from "lucide-react";
import Link from "next/link";

import { RunStatusBadge } from "@/components/run-status-badge";

interface BreadcrumbCrumb {
  label: string;
  href?: string;
}

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
 * Two-row contextual header rendered above page tabs on detail routes
 * (today: run/checkpoint diff viewer). Row 1 = breadcrumb + title +
 * status; Row 2 = metadata chips. Mirrors the reference enterprise-app
 * pattern: high information density, mono font for machine values,
 * lucide icons for visual rhythm.
 *
 * Callers compose the breadcrumb (parents own routing knowledge) and
 * metadata (server-fetched run data). The component is pure presentation.
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
      {/* Row 1: breadcrumb · title · status — actions */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <BreadcrumbList items={breadcrumb} />
          <span className="hidden h-4 w-px bg-zinc-300 dark:bg-zinc-700 md:block" />
          <div className="flex min-w-0 items-center gap-3">
            <h1
              className="truncate text-base font-semibold leading-tight text-zinc-900 dark:text-white md:text-lg"
              data-testid="contextual-header-title"
            >
              {title}
            </h1>
            {statusNode ?? (status ? <RunStatusBadge status={status} /> : null)}
          </div>
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

function BreadcrumbList({ items }: { items: BreadcrumbCrumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400"
    >
      {items.map((crumb, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <span
            key={`${crumb.label}-${idx}`}
            className="flex items-center gap-1.5 min-w-0"
          >
            {crumb.href && !isLast ? (
              <Link
                href={crumb.href}
                className="truncate transition-colors hover:text-zinc-900 dark:hover:text-white"
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={
                  isLast
                    ? "truncate font-medium text-zinc-700 dark:text-zinc-200"
                    : "truncate"
                }
                aria-current={isLast ? "page" : undefined}
              >
                {crumb.label}
              </span>
            )}
            {!isLast ? (
              <ChevronRight
                className="h-3 w-3 shrink-0 text-zinc-400 dark:text-zinc-600"
                aria-hidden
              />
            ) : null}
          </span>
        );
      })}
    </nav>
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
  const startedLabel = startedDate ? formatRelative(startedDate) : null;
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

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return "just now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
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
