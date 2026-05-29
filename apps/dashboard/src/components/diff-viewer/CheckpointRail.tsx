"use client";

import { useEffect } from "react";

import { CheckpointCard, type CheckpointSummary } from "./CheckpointCard";

export function CheckpointRail({
  items,
  selectedId,
  onSelect,
}: {
  items: CheckpointSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLElement &&
        e.target.matches("input, textarea, [contenteditable=true]")
      )
        return;
      const idx = items.findIndex((i) => i.id === selectedId);
      if (idx === -1) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        const next = items[Math.min(items.length - 1, idx + 1)];
        if (next && next.id !== selectedId) {
          e.preventDefault();
          onSelect(next.id);
        }
      } else if (e.key === "ArrowUp" || e.key === "k") {
        const prev = items[Math.max(0, idx - 1)];
        if (prev && prev.id !== selectedId) {
          e.preventDefault();
          onSelect(prev.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selectedId, onSelect]);

  return (
    <aside
      className="flex w-60 flex-col gap-1 border-r border-zinc-200 bg-zinc-50/40 p-2 dark:border-zinc-800 dark:bg-zinc-950/40"
      data-testid="checkpoint-rail"
    >
      <h2 className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
        Checkpoints
      </h2>
      {items.map((item) => (
        <CheckpointCard
          key={item.id}
          item={item}
          selected={item.id === selectedId}
          onClick={() => onSelect(item.id)}
        />
      ))}
    </aside>
  );
}
