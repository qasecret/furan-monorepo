"use client";

import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CheckpointCard, type CheckpointSummary } from "./CheckpointCard";

export type { CheckpointSummary };

/**
 * "Changes" semantics: any checkpoint where the reviewer has to look at
 * something. `unresolved` (diffs detected) and `failed` (override-failed)
 * both count. `new`, `passed`, `running`, `aborted`, `empty` don't.
 *
 * Single source of truth shared by the count display and the
 * "Changes only" filter so the two never disagree.
 */
function isChange(item: CheckpointSummary): boolean {
  return item.status === "unresolved" || item.status === "failed";
}

export function CheckpointRail({
  items,
  selectedId,
  onSelect,
}: {
  items: CheckpointSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [filterText, setFilterText] = useState("");
  const [changesOnly, setChangesOnly] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLElement &&
        e.target.matches("input, textarea, [contenteditable=true]")
      )
        return;
      const idx = visibleItems.findIndex((i) => i.id === selectedId);
      if (idx === -1) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        const next = visibleItems[Math.min(visibleItems.length - 1, idx + 1)];
        if (next && next.id !== selectedId) {
          e.preventDefault();
          onSelect(next.id);
        }
      } else if (e.key === "ArrowUp" || e.key === "k") {
        const prev = visibleItems[Math.max(0, idx - 1)];
        if (prev && prev.id !== selectedId) {
          e.preventDefault();
          onSelect(prev.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterText, changesOnly, items, selectedId, onSelect]);

  const changeCount = useMemo(() => items.filter(isChange).length, [items]);

  const visibleItems = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return items.filter((item) => {
      if (changesOnly && !isChange(item)) return false;
      if (needle && !item.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [items, filterText, changesOnly]);

  return (
    <aside
      className="flex w-[260px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-950/40"
      data-testid="checkpoint-rail"
    >
      {/* Header — count summary + filter + Changes only toggle */}
      <div className="space-y-3 border-b border-zinc-200 px-3 py-3 dark:border-zinc-800">
        <div
          className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500"
          data-testid="checkpoint-rail-count"
        >
          {items.length} checkpoint{items.length === 1 ? "" : "s"}
          {changeCount > 0
            ? ` · ${changeCount} change${changeCount === 1 ? "" : "s"}`
            : ""}
        </div>
        <div className="relative">
          <Search
            className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400 dark:text-zinc-500"
            aria-hidden
          />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter checkpoints…"
            aria-label="Filter checkpoints"
            data-testid="checkpoint-rail-filter"
            className="h-7 w-full rounded-md border border-zinc-200 bg-white pl-8 pr-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand/40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:placeholder:text-zinc-500"
          />
        </div>
        <label className="flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={changesOnly}
            onChange={(e) => setChangesOnly(e.target.checked)}
            data-testid="checkpoint-rail-changes-only"
            className="h-3 w-3 rounded border-zinc-300 text-brand focus:ring-brand/40 dark:border-zinc-700 dark:bg-zinc-900"
          />
          Changes only
        </label>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {visibleItems.length === 0 ? (
          <p
            className="px-2 py-4 text-center text-xs text-zinc-500"
            data-testid="checkpoint-rail-empty"
          >
            {items.length === 0
              ? "No checkpoints yet"
              : "No matching checkpoints"}
          </p>
        ) : (
          visibleItems.map((item) => (
            <CheckpointCard
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onClick={() => onSelect(item.id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
