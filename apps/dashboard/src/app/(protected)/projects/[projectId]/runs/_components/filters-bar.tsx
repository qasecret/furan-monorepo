"use client";

import { type RunStatus, runStatusSchema } from "@furan/shared-types";
import { ChevronDown } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { STATUS_CONFIG } from "@/components/run-status-badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

/**
 * Status filter options — the full 7-value `runStatusSchema` enum, presented
 * in the spec §3.5 reviewer-attention order: most-actionable (unresolved)
 * near the top, terminal states grouped at the bottom.
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

/**
 * Device/environment filter shape — mirrors the runs.list tRPC input on
 * the backend. All optional; per ADR-038 only `customTags` is applied at
 * the run level today (browser/viewport/os/device are accepted but resolved
 * against screenshots in a later phase), which is why they live behind the
 * collapsed "More filters" disclosure rather than the always-visible row.
 */
export interface DeviceFilters {
  browser?: string;
  viewport?: string;
  os?: string;
  device?: string;
  customTags?: string;
}

/** Per-status run totals for the chip labels (from `runs.statusCounts`). */
export interface StatusCounts {
  total: number;
  counts: Partial<Record<RunStatus, number>>;
}

interface Props {
  initialBranch?: string;
  initialStatus?: readonly RunStatus[];
  initialDevice?: DeviceFilters;
  /** Project-wide per-status counts; chips render their numbers from this. */
  statusCounts?: StatusCounts;
  onChange: (
    filters: {
      branch?: string;
      status?: RunStatus[];
    } & DeviceFilters,
  ) => void;
}

/**
 * Extract a dot-fill colour from the badge className. STATUS_CONFIG[*]
 * className starts with e.g. `bg-amber-500/10`, which renders nearly
 * invisibly as a small dot. Strip the `/10` suffix so the dot uses the
 * full-alpha variant of the same hue.
 */
function dotClass(status: RunStatus): string {
  const first = STATUS_CONFIG[status].className.split(/\s+/)[0];
  const stripped = first?.replace("/10", "");
  return stripped ?? "bg-zinc-700";
}

/**
 * Filter bar for the runs index. Branch input is debounced 300ms; status is a
 * multi-select rendered as count chips (Applitools-style: one click to triage,
 * with project-wide totals). Device/env filters collapse behind "More filters"
 * so the default bar stays calm.
 *
 * All controls write back into the URL search params (replace, not push) so
 * filter state survives reload and is shareable; status uses repeated
 * `?status=` params, the conventional Next.js encoding.
 */
export function FiltersBar({
  initialBranch,
  initialStatus,
  initialDevice,
  statusCounts,
  onChange,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [statuses, setStatuses] = useState<ReadonlySet<RunStatus>>(
    () => new Set(initialStatus ?? []),
  );
  const [browser, setBrowser] = useState(initialDevice?.browser ?? "");
  const [viewport, setViewport] = useState(initialDevice?.viewport ?? "");
  const [os, setOs] = useState(initialDevice?.os ?? "");
  const [device, setDevice] = useState(initialDevice?.device ?? "");
  const [customTags, setCustomTags] = useState(initialDevice?.customTags ?? "");
  // Auto-expand the advanced row when it has an active filter on mount so a
  // shared URL never hides a filter that's actually narrowing the results.
  const [showMore, setShowMore] = useState(
    () =>
      !!(
        initialDevice?.browser ||
        initialDevice?.viewport ||
        initialDevice?.os ||
        initialDevice?.device ||
        initialDevice?.customTags
      ),
  );
  const [, startTransition] = useTransition();
  const firstRun = useRef(true);

  // Indirection refs keep the debounce effect's deps stable across renders
  // (callers may pass fresh `onChange`/`searchParams` every render).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const routerRef = useRef(router);
  routerRef.current = router;

  // Stable, deterministically-ordered list for the URL + tRPC payload.
  const orderedStatuses = useMemo(
    () => STATUS_OPTIONS.filter((s) => statuses.has(s)),
    [statuses],
  );

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
      next.delete("status");
      for (const s of orderedStatuses) next.append("status", s);
      const writeOne = (key: string, value: string) => {
        if (value) next.set(key, value);
        else next.delete(key);
      };
      writeOne("browser", browser);
      writeOne("viewport", viewport);
      writeOne("os", os);
      writeOne("device", device);
      writeOne("customTags", customTags);
      startTransition(() => routerRef.current.replace(`?${next.toString()}`));
      onChangeRef.current({
        branch: branch || undefined,
        status: orderedStatuses.length > 0 ? [...orderedStatuses] : undefined,
        browser: browser || undefined,
        viewport: viewport || undefined,
        os: os || undefined,
        device: device || undefined,
        customTags: customTags || undefined,
      });
    }, 300);
    return () => clearTimeout(t);
  }, [branch, orderedStatuses, browser, viewport, os, device, customTags]);

  const toggle = (status: RunStatus) => {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  // Validate at module-init that every option round-trips through the schema —
  // guards against a future enum widening where STATUS_OPTIONS drifts from
  // runStatusSchema. Cheap (7 elements); throws synchronously in dev.
  useEffect(() => {
    for (const s of STATUS_OPTIONS) {
      runStatusSchema.parse(s);
    }
  }, []);

  // Chips: show "All" plus every status that has runs or is currently
  // selected. Before counts load, show the full set so the row doesn't pop in.
  const visibleStatuses = STATUS_OPTIONS.filter(
    (s) =>
      !statusCounts || statuses.has(s) || (statusCounts.counts[s] ?? 0) > 0,
  );
  const activeDeviceCount = [browser, viewport, os, device, customTags].filter(
    Boolean,
  ).length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Input
          placeholder="Filter by branch…"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className="w-full sm:w-52"
          data-testid="branch-filter-input"
        />
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Filter by status"
        >
          <FilterChip
            label="All"
            count={statusCounts?.total}
            active={statuses.size === 0}
            onClick={() => setStatuses(new Set())}
            testId="status-chip-all"
          />
          {visibleStatuses.map((s) => (
            <FilterChip
              key={s}
              label={STATUS_CONFIG[s].label}
              count={statusCounts?.counts[s]}
              dot={dotClass(s)}
              activeClassName={STATUS_CONFIG[s].className}
              active={statuses.has(s)}
              onClick={() => toggle(s)}
              testId={`status-chip-${s}`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          data-testid="more-filters-toggle"
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900/60 dark:hover:text-white"
        >
          More filters
          {activeDeviceCount > 0 ? (
            <span className="rounded-full bg-brand/20 px-1.5 text-[10px] text-brand">
              {activeDeviceCount}
            </span>
          ) : null}
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              showMore && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </div>
      {showMore ? (
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-2.5 sm:flex sm:flex-wrap sm:items-center dark:border-zinc-800 dark:bg-zinc-900/30">
          <Input
            placeholder="browser"
            value={browser}
            onChange={(e) => setBrowser(e.target.value)}
            className="w-full sm:w-32"
            aria-label="Filter by browser"
            data-testid="browser-filter-input"
          />
          <Input
            placeholder="viewport"
            value={viewport}
            onChange={(e) => setViewport(e.target.value)}
            className="w-full sm:w-32"
            aria-label="Filter by viewport"
            data-testid="viewport-filter-input"
          />
          <Input
            placeholder="os"
            value={os}
            onChange={(e) => setOs(e.target.value)}
            className="w-full sm:w-28"
            aria-label="Filter by OS"
            data-testid="os-filter-input"
          />
          <Input
            placeholder="device"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            className="w-full sm:w-32"
            aria-label="Filter by device"
            data-testid="device-filter-input"
          />
          <Input
            placeholder="tag substring"
            value={customTags}
            onChange={(e) => setCustomTags(e.target.value)}
            className="col-span-2 sm:col-span-1 sm:w-36"
            aria-label="Filter by custom tag (substring)"
            data-testid="custom-tags-filter-input"
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One status filter chip. Inactive chips are neutral; the active chip adopts
 * its status tint (`activeClassName`) so the selected filter reads at a glance,
 * mirroring the status badge colours.
 */
function FilterChip({
  label,
  count,
  dot,
  active,
  activeClassName,
  onClick,
  testId,
}: {
  label: string;
  count?: number;
  dot?: string;
  active: boolean;
  activeClassName?: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? (activeClassName ??
              "border-brand/40 bg-brand/15 text-zinc-900 dark:text-brand")
          : "border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900/60",
      )}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn("inline-block h-2 w-2 rounded-full", dot)}
        />
      ) : null}
      {label}
      {typeof count === "number" ? (
        <span className="tabular-nums opacity-70">{count}</span>
      ) : null}
    </button>
  );
}
