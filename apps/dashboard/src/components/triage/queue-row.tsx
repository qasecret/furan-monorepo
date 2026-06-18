"use client";

import type { InboxRunRow } from "@furan/shared-types";
import { Check, ChevronRight, ExternalLink, X } from "lucide-react";
import Link from "next/link";

import { StatusPill } from "./status-pill";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";

interface Props {
  row: InboxRunRow;
  selected: boolean;
  onApprove: () => void;
  onReject: () => void;
}

export function QueueRow({ row, selected, onApprove, onReject }: Props) {
  // The viewer is keyed by (runId, diffId); for a row-level open we pass runId
  // in both segments — the page redirects to the run's first diff when they
  // don't match an exact diff record.
  const diffHref = `/projects/${row.projectId}/runs/${row.runId}/diffs/${row.runId}`;
  return (
    <li
      role="listitem"
      data-testid={`queue-row-${row.runId}`}
      aria-label={`Run ${row.variationName} in ${row.projectName}, ${row.status}`}
      className={cn(
        "group flex items-center gap-3 border-b border-zinc-100 px-4 py-3 hover:bg-zinc-100/60 focus-visible:outline-none dark:border-zinc-900 dark:hover:bg-zinc-900/40",
        selected &&
          "bg-zinc-200/70 ring-2 ring-brand/60 dark:bg-zinc-900/60 dark:ring-brand/40",
      )}
    >
      <ChevronRight
        className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-600"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-950 dark:text-white">
            {row.variationName}
          </span>
          <span className="truncate text-xs text-zinc-600 dark:text-zinc-400">
            · {row.projectName}
          </span>
          <StatusPill status={row.status} />
        </div>
        <div className="mt-0.5 truncate text-xs text-zinc-600 dark:text-zinc-400">
          <Link
            href={`/projects/${row.projectId}/builds/${row.buildId}`}
            onClick={(e) => e.stopPropagation()}
            className="hover:underline"
          >
            {row.buildNumber !== null ? `Build #${row.buildNumber}` : "Build"}
          </Link>
          {" · "}
          {row.branch ?? "—"} · {formatRelativeTime(row.createdAt)}
        </div>
      </div>
      {row.thumbnailUrl !== null ? (
        <img
          src={row.thumbnailUrl}
          alt=""
          loading="lazy"
          className="h-10 w-16 shrink-0 rounded border border-zinc-200 object-cover dark:border-zinc-800"
        />
      ) : (
        <div
          className={cn(
            "h-10 w-16 shrink-0 rounded border",
            "border-zinc-200 bg-[repeating-linear-gradient(45deg,#e4e4e7,#e4e4e7_4px,#d4d4d8_4px,#d4d4d8_8px)]",
            "dark:border-zinc-800 dark:bg-[repeating-linear-gradient(45deg,#18181b,#18181b_4px,#1f1f23_4px,#1f1f23_8px)]",
          )}
          aria-hidden
        />
      )}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          className="px-2 py-1"
          onClick={onApprove}
          title="Approve (a)"
          aria-label={`Approve ${row.variationName}`}
        >
          <Check className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
        </Button>
        <Button
          variant="ghost"
          className="px-2 py-1"
          onClick={onReject}
          title="Reject (r)"
          aria-label={`Reject ${row.variationName}`}
        >
          <X className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
        </Button>
        <Link
          href={diffHref}
          className="rounded p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          title="Open diff viewer (Enter)"
          aria-label={`Open diff viewer for ${row.variationName}`}
        >
          <ExternalLink className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
        </Link>
      </div>
    </li>
  );
}
