"use client";

import type { InboxStatusFilter, InboxWindowFilter } from "@furan/shared-types";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  status: InboxStatusFilter;
  window: InboxWindowFilter;
  groupBy: boolean;
}

export function FilterBar({ status, window, groupBy }: Props) {
  const router = useRouter();
  const params = useSearchParams();

  const update = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null) next.delete(key);
      else next.set(key, value);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  return (
    <div
      data-testid="inbox-filter-bar"
      className="sticky top-0 z-10 flex items-center gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-900 dark:bg-[#050505]"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Filter
      </span>
      <Select
        value={status}
        onValueChange={(v) => update("status", v === "all-open" ? null : v)}
      >
        <SelectTrigger className="h-8 w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all-open">All open</SelectItem>
          <SelectItem value="unresolved">Unresolved</SelectItem>
          <SelectItem value="failed">Failed</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={window}
        onValueChange={(v) => update("window", v === "7d" ? null : v)}
      >
        <SelectTrigger className="h-8 w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="24h">Last 24h</SelectItem>
          <SelectItem value="7d">Last 7d</SelectItem>
          <SelectItem value="30d">Last 30d</SelectItem>
          <SelectItem value="all">All time</SelectItem>
        </SelectContent>
      </Select>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          checked={groupBy}
          onChange={(e) =>
            update("group", e.target.checked ? "similarity" : null)
          }
          className="h-4 w-4 cursor-pointer rounded border border-zinc-300 accent-brand dark:border-zinc-700 dark:accent-white"
        />
        Group similar changes
      </label>
    </div>
  );
}
