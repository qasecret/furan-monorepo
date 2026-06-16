"use client";

import { useState } from "react";

export function WhyPanel({
  summary,
  severity,
  source,
  children,
}: {
  summary: string;
  severity?: string;
  source?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-zinc-800" data-testid="why-panel">
      <button
        type="button"
        data-testid="why-panel-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-zinc-400 hover:bg-zinc-900"
      >
        <span className="font-medium text-zinc-200">Why this changed</span>
        <span className="truncate">
          — {summary}
          {severity ? ` · severity ${severity}` : ""}
          {source ? ` · from ${source}` : ""}
        </span>
        <span className="ml-auto" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}
