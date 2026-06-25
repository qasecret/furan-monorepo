import { AlertTriangle, Check, ChevronDown, GitBranch, X } from "lucide-react";

import { Reveal } from "./reveal";

import { cn } from "@/lib/cn";

const RUNS = [
  { id: "PR-401", name: "Fix hero padding", status: "pass" as const },
  { id: "PR-400", name: "Add pricing page", status: "pass" as const },
  { id: "PR-399", name: "Bump dependencies", status: "pending" as const },
  { id: "PR-398", name: "Refactor button", status: "pass" as const },
];

/**
 * A static, theme-aware mock of Furan's diff viewer — baseline vs. current
 * with a highlighted regression. On-brand because the product itself is a
 * diff viewer; doubles as the landing's hero screenshot without shipping a
 * real PNG.
 */
export function LandingProductPreview() {
  return (
    <section id="preview" className="px-4 pb-10">
      <Reveal className="mx-auto max-w-6xl">
        {/* Decorative product screenshot stand-in — hidden from assistive tech. */}
        <div
          aria-hidden="true"
          className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-950/5 dark:border-zinc-800 dark:bg-zinc-950 dark:shadow-brand/5"
        >
          <div className="flex h-[560px] flex-col md:flex-row">
            {/* run list */}
            <aside className="hidden w-64 flex-col border-r border-zinc-200 dark:border-zinc-800 md:flex">
              <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
                <div className="mb-2 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
                  Recent test runs
                </div>
                <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-100 p-2 text-sm text-zinc-950 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white">
                  <X className="h-4 w-4 shrink-0 text-red-500" />
                  <span className="truncate">PR-402: Redesign nav</span>
                </div>
              </div>
              <div className="flex-1 space-y-1 overflow-hidden p-2">
                {RUNS.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-2 rounded-md p-2 text-sm text-zinc-500 dark:text-zinc-400"
                  >
                    {r.status === "pass" ? (
                      <Check className="h-4 w-4 shrink-0 text-brand-text" />
                    ) : (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
                    )}
                    <span className="truncate">
                      {r.id}: {r.name}
                    </span>
                  </div>
                ))}
              </div>
            </aside>

            {/* main */}
            <div className="flex flex-1 flex-col">
              <div className="flex h-14 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
                <div className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-100 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
                  <GitBranch className="h-4 w-4 text-zinc-500" />
                  <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                    feature/redesign-nav
                  </span>
                  <ChevronDown className="h-3 w-3 text-zinc-400" />
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-xs font-medium text-red-500">
                    <AlertTriangle className="h-3 w-3" /> 2 changes
                  </span>
                  <span className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-black">
                    Approve
                  </span>
                </div>
              </div>
              <div className="flex flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-black lg:flex-row">
                <DiffPane label="Baseline · main" accent={false} />
                <div className="border-zinc-200 dark:border-zinc-800 lg:border-l" />
                <DiffPane label="Current · feature/redesign-nav" accent />
              </div>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

function DiffPane({ label, accent }: { label: string; accent: boolean }) {
  return (
    <div className="relative flex flex-1 items-center justify-center p-8">
      <span
        className={cn(
          "absolute left-4 top-4 rounded border px-2 py-1 font-mono text-[11px] backdrop-blur",
          accent
            ? "border-brand/30 bg-brand/10 text-brand-text"
            : "border-zinc-200 bg-white/70 text-zinc-500 dark:border-zinc-800 dark:bg-black/60 dark:text-zinc-400",
        )}
      >
        {label}
      </span>
      <div className="w-full max-w-xs overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex h-11 items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <div className="h-5 w-5 rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-2 w-14 rounded-full bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-2 w-10 rounded-full bg-zinc-200 dark:bg-zinc-700" />
        </div>
        <div className="space-y-3 p-5">
          <div className="h-5 w-3/4 rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-2 w-full rounded-full bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-2 w-5/6 rounded-full bg-zinc-100 dark:bg-zinc-800" />
          <div className="relative pt-3">
            {accent && (
              <>
                <span className="absolute -inset-2 z-10 rounded-lg border-2 border-dashed border-red-500 bg-red-500/10" />
                <span className="absolute -top-5 right-0 z-20 rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white shadow">
                  Padding +8px
                </span>
              </>
            )}
            <div
              className={cn(
                "rounded-md bg-brand",
                accent ? "h-11 w-40" : "h-9 w-32",
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
