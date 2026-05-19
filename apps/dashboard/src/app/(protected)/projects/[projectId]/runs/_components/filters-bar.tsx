"use client";

import { type RunStatus, runStatusSchema } from "@furan/shared-types";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { STATUS_CONFIG } from "@/components/run-status-badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Status filter options — the full 7-value `runStatusSchema` enum, presented
 * in the spec §3.5 reviewer-attention order: most-actionable (unresolved)
 * near the top, terminal states grouped at the bottom. Labels reuse
 * `STATUS_CONFIG` so they match the badge presentation.
 */
const STATUS_OPTIONS: readonly RunStatus[] = [
  "unresolved",
  "failed",
  "aborted",
  "empty",
  "running",
  "new",
  "passed",
];

const ALL_SENTINEL = "__all" as const;

interface Props {
  initialBranch?: string;
  initialStatus?: RunStatus;
  onChange: (filters: { branch?: string; status?: RunStatus }) => void;
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
  const [status, setStatus] = useState<string>(initialStatus ?? ALL_SENTINEL);
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
      // Parse the select value back to the typed `RunStatus` via the
      // canonical Zod schema — any non-enum value (including the
      // `__all` sentinel) becomes `undefined` and clears the URL param.
      const parsedStatus = runStatusSchema.safeParse(status);
      if (parsedStatus.success) next.set("status", parsedStatus.data);
      else next.delete("status");
      startTransition(() => routerRef.current.replace(`?${next.toString()}`));
      onChangeRef.current({
        branch: branch || undefined,
        status: parsedStatus.success ? parsedStatus.data : undefined,
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
          className="w-44"
          data-testid="status-filter-trigger"
          aria-label="Filter by status"
        >
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_SENTINEL}>All statuses</SelectItem>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {STATUS_CONFIG[s].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
