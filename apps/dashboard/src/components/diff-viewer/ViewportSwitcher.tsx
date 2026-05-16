"use client";

import { useViewerStore } from "./useViewerStore";

import { cn } from "@/lib/cn";

export function ViewportSwitcher({ viewports }: { viewports: string[] }) {
  const active = useViewerStore((s) => s.viewport);
  const setViewport = useViewerStore((s) => s.setViewport);

  if (viewports.length === 0) return null;

  return (
    <div className="flex gap-1 flex-wrap" data-testid="viewport-switcher">
      {viewports.map((vp) => (
        <button
          key={vp}
          type="button"
          onClick={() => setViewport(vp)}
          className={cn(
            "text-xs px-2 py-1 rounded border hover:bg-accent",
            active === vp && "bg-accent ring-1 ring-primary",
          )}
          data-viewport={vp}
        >
          {vp}
        </button>
      ))}
    </div>
  );
}
