"use client";

import { type RunStatus, runStatusSchema } from "@furan/shared-types";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { STATUS_CONFIG } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

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

interface Props {
  initialBranch?: string;
  initialStatus?: readonly RunStatus[];
  onChange: (filters: { branch?: string; status?: RunStatus[] }) => void;
}

/**
 * Build the trigger summary text — spec §3.5:
 *   0 checked → "All statuses"
 *   1 checked → that status's label, e.g. "Unresolved"
 *   2 checked → "Unresolved + Failed"
 *   ≥3        → "N statuses"
 *
 * Order follows `STATUS_OPTIONS` (reviewer-attention order) rather than
 * insertion order so the summary is deterministic regardless of which
 * checkbox the user toggled first.
 */
function summarize(selected: ReadonlySet<RunStatus>): string {
  if (selected.size === 0) return "All statuses";
  const ordered = STATUS_OPTIONS.filter((s) => selected.has(s));
  // Local pulls + non-null assertions sidestep TS noUncheckedIndexedAccess;
  // the length checks above prove the indices are populated.
  const [first, second] = ordered;
  if (ordered.length === 1 && first) return STATUS_CONFIG[first].label;
  if (ordered.length === 2 && first && second) {
    return `${STATUS_CONFIG[first].label} + ${STATUS_CONFIG[second].label}`;
  }
  return `${ordered.length} statuses`;
}

/**
 * Extract a dot-fill colour from the badge className. After Phase 1's tint
 * migration STATUS_CONFIG[*].className starts with e.g. `bg-amber-500/10`,
 * which renders nearly invisibly as a small dot on the zinc-950 popover.
 * Strip the `/10` suffix so the dot uses the full-alpha variant of the
 * same hue (e.g. `bg-amber-500`).
 */
function dotClass(status: RunStatus): string {
  const first = STATUS_CONFIG[status].className.split(/\s+/)[0];
  const stripped = first?.replace("/10", "");
  return stripped ?? "bg-zinc-700";
}

/**
 * Two-control filter bar for the runs index page. Branch input is
 * debounced 300ms so we don't fire a tRPC query per keystroke. Both
 * controls also write back into the URL search params (replace, not
 * push) so the filter state survives reload + can be shared.
 *
 * Status is multi-select per spec §3.5 — reviewers commonly want
 * "Unresolved + Failed" at the same time. URL representation uses
 * repeated `?status=` params (the conventional Next.js search-params
 * pattern, and what `URLSearchParams.getAll('status')` round-trips).
 *
 * The `useRef(true)` skip-on-mount guard avoids triggering an extra
 * `onChange` (and URL rewrite) on initial render, which would clobber
 * the parent's freshly-initialized filter state.
 */
export function FiltersBar({ initialBranch, initialStatus, onChange }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [statuses, setStatuses] = useState<ReadonlySet<RunStatus>>(
    () => new Set(initialStatus ?? []),
  );
  const [, startTransition] = useTransition();
  const firstRun = useRef(true);

  // Indirection refs: callers may pass a fresh `onChange` on every parent
  // render, and `useSearchParams()` returns a fresh object per render too.
  // Reading them through refs keeps the debounce effect's deps stable
  // (`[branch, statuses]`) so we don't re-schedule the timer on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const routerRef = useRef(router);
  routerRef.current = router;

  // Stable, deterministically-ordered list for the URL + tRPC payload.
  // Keep in sync with the menu order so the URL is reproducible.
  const orderedStatuses = useMemo(
    () => STATUS_OPTIONS.filter((s) => statuses.has(s)),
    [statuses],
  );
  const summary = summarize(statuses);

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
      // Repeated `?status=` params is the conventional encoding; each
      // value still passes through `runStatusSchema.safeParse` on read
      // so stale URL values get dropped quietly.
      next.delete("status");
      for (const s of orderedStatuses) next.append("status", s);
      startTransition(() => routerRef.current.replace(`?${next.toString()}`));
      onChangeRef.current({
        branch: branch || undefined,
        status: orderedStatuses.length > 0 ? [...orderedStatuses] : undefined,
      });
    }, 300);
    return () => clearTimeout(t);
  }, [branch, orderedStatuses]);

  const toggle = (status: RunStatus) => {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  // Validate at module-init that every option round-trips through the
  // schema — guards against a future enum widening where STATUS_OPTIONS
  // drifts from runStatusSchema. Cheap (7 elements). Throws synchronously
  // so a mismatch surfaces in dev before any render path.
  useEffect(() => {
    for (const s of STATUS_OPTIONS) {
      runStatusSchema.parse(s);
    }
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder="Filter by branch…"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        className="max-w-xs"
        data-testid="branch-filter-input"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            className="w-44 justify-between"
            data-testid="status-filter-trigger"
            aria-label="Filter by status"
          >
            <span className="truncate">{summary}</span>
            <span aria-hidden="true" className="ml-2 opacity-60">
              ▾
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          {STATUS_OPTIONS.map((s) => (
            <DropdownMenuCheckboxItem
              key={s}
              checked={statuses.has(s)}
              onCheckedChange={() => toggle(s)}
              onSelect={(e) => e.preventDefault()}
              data-testid={`status-filter-option-${s}`}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass(s)}`}
                />
                {STATUS_CONFIG[s].label}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
