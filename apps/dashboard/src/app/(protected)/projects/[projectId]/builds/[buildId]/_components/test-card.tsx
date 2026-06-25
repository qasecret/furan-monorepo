"use client";

import { Check, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { StatusPill } from "@/components/triage/status-pill";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { RouterOutputs } from "@/lib/trpc";

export type TestCardData = RouterOutputs["runs"]["list"]["items"][number];

interface Props {
  projectId: string;
  row: TestCardData;
  onApprove: (runId: string) => void;
  onReject: (runId: string) => void;
  canReview: boolean;
}

export function TestCard({
  projectId,
  row,
  onApprove,
  onReject,
  canReview,
}: Props) {
  const router = useRouter();
  const open = () =>
    router.push(`/projects/${projectId}/runs/${row.id}/checkpoints/_first`);
  // Reference-style left accent bar, colored by the run's status.
  const statusAccent =
    row.status === "failed"
      ? "bg-red-500"
      : row.status === "unresolved"
        ? "bg-amber-500"
        : row.status === "passed"
          ? "bg-emerald-500"
          : row.status === "running"
            ? "bg-blue-500"
            : row.status === "new"
              ? "bg-sky-500"
              : "bg-zinc-300 dark:bg-zinc-700";
  return (
    <div
      data-testid={`test-card-${row.id}`}
      onClick={open}
      role="button"
      tabIndex={0}
      aria-label={`Open ${row.name}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="group relative flex cursor-pointer flex-col gap-2 overflow-hidden rounded-lg border border-zinc-200 bg-white p-2 transition-colors hover:border-brand/40 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-brand/40 dark:hover:bg-zinc-900/40"
    >
      <span
        aria-hidden
        className={cn("absolute inset-y-0 left-0 w-1", statusAccent)}
      />
      {row.thumbnailUrl !== null ? (
        <img
          src={row.thumbnailUrl}
          alt=""
          loading="lazy"
          className="aspect-video w-full rounded border border-zinc-200 object-cover dark:border-zinc-800"
        />
      ) : (
        <div
          className={cn(
            "aspect-video w-full rounded border",
            "border-zinc-200 bg-[repeating-linear-gradient(45deg,#e4e4e7,#e4e4e7_4px,#d4d4d8_4px,#d4d4d8_8px)]",
            "dark:border-zinc-800 dark:bg-[repeating-linear-gradient(45deg,#18181b,#18181b_4px,#1f1f23_4px,#1f1f23_8px)]",
          )}
          aria-hidden
        />
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-950 transition-colors group-hover:text-brand-text dark:text-white">
          {row.name}
        </span>
        <StatusPill status={row.status} />
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-zinc-600 dark:text-zinc-400">
          {row.diffPercent !== null
            ? `${row.diffPercent.toFixed(1)}% changed`
            : "—"}
        </span>
        {canReview ? (
          <>
            <Button
              variant="ghost"
              className="px-2 py-1 text-zinc-700 hover:text-emerald-600 dark:text-zinc-300 dark:hover:text-emerald-400"
              data-testid={`test-card-approve-${row.id}`}
              aria-label={`Approve ${row.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onApprove(row.id);
              }}
            >
              <Check className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              className="px-2 py-1 text-zinc-700 hover:text-red-600 dark:text-zinc-300 dark:hover:text-red-400"
              data-testid={`test-card-reject-${row.id}`}
              aria-label={`Reject ${row.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onReject(row.id);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
