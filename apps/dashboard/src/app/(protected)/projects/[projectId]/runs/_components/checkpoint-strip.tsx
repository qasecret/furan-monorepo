"use client";

import Link from "next/link";

import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  runId: string;
}

/**
 * ADR-038: expandable per-checkpoint strip rendered below a RunRow.
 * Fetches the checkpoint list for the run and renders each checkpoint
 * as a single horizontal line: name + status pill.
 */
export function CheckpointStrip({ projectId, runId }: Props) {
  const { data, isLoading, error } = trpc.runs.listCheckpoints.useQuery({
    runId,
  });

  if (isLoading) {
    return (
      <div
        className="py-2 text-xs text-zinc-500"
        data-testid={`checkpoint-strip-${runId}`}
      >
        Loading checkpoints…
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="py-2 text-xs text-red-400"
        data-testid={`checkpoint-strip-${runId}`}
      >
        Failed to load checkpoints
      </div>
    );
  }
  if (!data?.items?.length) {
    return (
      <div
        className="py-2 text-xs text-zinc-500"
        data-testid={`checkpoint-strip-${runId}`}
      >
        No checkpoints
      </div>
    );
  }

  return (
    <div
      className="flex flex-wrap gap-2 py-2"
      data-testid={`checkpoint-strip-${runId}`}
    >
      {data.items.map((checkpoint) => (
        <Link
          key={checkpoint.id}
          href={`/projects/${projectId}/runs/${runId}/checkpoints/${checkpoint.id}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900/70 dark:hover:text-white"
          data-testid={`checkpoint-strip-item-${checkpoint.id}`}
        >
          <span className="font-medium">
            {checkpoint.name ?? checkpoint.id}
          </span>
        </Link>
      ))}
    </div>
  );
}
