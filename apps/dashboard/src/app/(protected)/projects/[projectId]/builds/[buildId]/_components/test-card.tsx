"use client";

import type { RunStatus } from "@furan/shared-types";
import { Check, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { StatusPill } from "@/components/triage/status-pill";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface TestCardData {
  id: string;
  name: string;
  status: RunStatus;
  diffPercent: number | null;
  thumbnailUrl: string | null;
}

interface Props {
  projectId: string;
  row: TestCardData;
  onApprove: (runId: string) => void;
  onReject: (runId: string) => void;
}

export function TestCard({ projectId, row, onApprove, onReject }: Props) {
  const router = useRouter();
  const open = () =>
    router.push(`/projects/${projectId}/runs/${row.id}/checkpoints/_first`);
  return (
    <div
      data-testid={`test-card-${row.id}`}
      onClick={open}
      className="group flex cursor-pointer flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-2 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900/40"
    >
      {row.thumbnailUrl !== null ? (
        <img
          src={row.thumbnailUrl}
          alt=""
          loading="lazy"
          className="h-24 w-full rounded border border-zinc-200 object-cover dark:border-zinc-800"
        />
      ) : (
        <div
          className={cn(
            "h-24 w-full rounded border",
            "border-zinc-200 bg-[repeating-linear-gradient(45deg,#e4e4e7,#e4e4e7_4px,#d4d4d8_4px,#d4d4d8_8px)]",
            "dark:border-zinc-800 dark:bg-[repeating-linear-gradient(45deg,#18181b,#18181b_4px,#1f1f23_4px,#1f1f23_8px)]",
          )}
          aria-hidden
        />
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-950 dark:text-white">
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
        <Button
          variant="ghost"
          className="px-2 py-1"
          data-testid={`test-card-approve-${row.id}`}
          aria-label={`Approve ${row.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onApprove(row.id);
          }}
        >
          <Check className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
        </Button>
        <Button
          variant="ghost"
          className="px-2 py-1"
          data-testid={`test-card-reject-${row.id}`}
          aria-label={`Reject ${row.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onReject(row.id);
          }}
        >
          <X className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
        </Button>
      </div>
    </div>
  );
}
