"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_OPTIONS = ["passed", "failed", "running", "new", "ok"] as const;

interface Props {
  initialBranch?: string;
  initialStatus?: string;
  onChange: (filters: { branch?: string; status?: string }) => void;
}

/**
 * Two-control filter bar for the runs index page. Branch input is
 * debounced 300ms so we don't fire a tRPC query per keystroke. Both
 * controls also write back into the URL search params (replace, not
 * push) so the filter state survives reload + can be shared.
 *
 * The `useRef(true)` skip-on-mount guard avoids triggering an extra
 * `onChange` (and URL rewrite) on initial render, which would clobber
 * the parent's freshly-initialized filter state.
 */
export function FiltersBar({ initialBranch, initialStatus, onChange }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [status, setStatus] = useState(initialStatus ?? "__all");
  const [, startTransition] = useTransition();
  const firstRun = useRef(true);

  // Indirection refs: callers may pass a fresh `onChange` on every parent
  // render, and `useSearchParams()` returns a fresh object per render too.
  // Reading them through refs keeps the debounce effect's deps stable
  // (`[branch, status]`) so we don't re-schedule the timer on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const t = setTimeout(() => {
      const next = new URLSearchParams(
        searchParamsRef.current?.toString() ?? "",
      );
      if (branch) next.set("branch", branch);
      else next.delete("branch");
      if (status && status !== "__all") next.set("status", status);
      else next.delete("status");
      startTransition(() => routerRef.current.replace(`?${next.toString()}`));
      onChangeRef.current({
        branch: branch || undefined,
        status: status !== "__all" ? status : undefined,
      });
    }, 300);
    return () => clearTimeout(t);
  }, [branch, status]);

  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="Filter by branch…"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        className="max-w-xs"
        data-testid="branch-filter-input"
      />
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger
          className="w-40"
          data-testid="status-filter-trigger"
          aria-label="Filter by status"
        >
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All statuses</SelectItem>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
