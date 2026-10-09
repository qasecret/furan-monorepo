import type { RunStatus } from "@furan/shared-types";
import { AlertTriangle, ChevronDown, GitBranch } from "lucide-react";

import { Reveal } from "./reveal";

import { cn } from "@/lib/cn";
import { statusStyle } from "@/lib/status-style";

const RUNS: ReadonlyArray<{ id: string; name: string; status: RunStatus }> = [
  { id: "PR-401", name: "Fix hero padding", status: "passed" },
  { id: "PR-400", name: "Add pricing page", status: "passed" },
  { id: "PR-399", name: "Bump dependencies", status: "unresolved" },
  { id: "PR-398", name: "Refactor button", status: "passed" },
];

/**
 * A static, theme-aware mock of Furan's diff viewer — baseline vs. current
 * with a highlighted regression. On-brand because the product itself is a
 * diff viewer; doubles as the landing's hero screenshot without shipping a
 * real PNG.
 *
 * The mock uses the real app's surface roles (raised frame, sunken diff well,
 * hover for the selected run) and its status styles, so it looks like the
 * product in both themes.
 */
export function LandingProductPreview() {
  return (
    <section id="preview" className="px-4 pb-10">
      <Reveal className="mx-auto max-w-6xl">
        {/* Decorative product screenshot stand-in — hidden from assistive tech. */}
        <div
          aria-hidden="true"
          className="overflow-hidden rounded-2xl bg-raised shadow-raised"
        >
          <div className="flex h-[560px] flex-col md:flex-row">
            {/* run list */}
            <aside className="hidden w-64 flex-col border-r border-edge md:flex">
              <div className="border-b border-edge p-4">
                <div className="mb-2 font-mono text-2xs uppercase tracking-wider text-fg-muted">
                  Recent test runs
                </div>
                <div className="flex items-center gap-2 rounded-md border border-edge bg-hover p-2 text-sm text-fg">
                  <RunStatusIcon status="failed" />
                  <span className="truncate">PR-402: Redesign nav</span>
                </div>
              </div>
              <div className="flex-1 space-y-1 overflow-hidden p-2">
                {RUNS.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-2 rounded-md p-2 text-sm text-fg-muted"
                  >
                    <RunStatusIcon status={r.status} />
                    <span className="truncate">
                      {r.id}: {r.name}
                    </span>
                  </div>
                ))}
              </div>
            </aside>

            {/* main */}
            <div className="flex flex-1 flex-col">
              <div className="flex h-14 items-center justify-between border-b border-edge px-4">
                <div className="flex items-center gap-2 rounded-md border border-edge bg-canvas px-3 py-1.5">
                  <GitBranch className="h-4 w-4 text-fg-muted" />
                  <span className="font-mono text-xs text-fg-secondary">
                    feature/redesign-nav
                  </span>
                  <ChevronDown className="h-3 w-3 text-fg-secondary" />
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex items-center gap-1 rounded px-2 py-1 text-xs font-medium",
                      statusStyle("failed").pill,
                    )}
                  >
                    <AlertTriangle className="h-3 w-3" /> 2 changes
                  </span>
                  <span className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-brand-fg shadow-brand-edge">
                    Approve
                  </span>
                </div>
              </div>
              <div className="flex flex-1 flex-col overflow-hidden bg-sunken lg:flex-row">
                <DiffPane label="Baseline · main" accent={false} />
                <div className="border-edge lg:border-l" />
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
          "absolute left-4 top-4 rounded border px-2 py-1 font-mono text-2xs backdrop-blur",
          accent
            ? "border-brand/30 bg-brand/10 text-brand-text"
            : "border-edge bg-canvas/70 text-fg-muted",
        )}
      >
        {label}
      </span>
      <div className="w-full max-w-xs overflow-hidden rounded-lg bg-raised shadow-raised">
        <div className="flex h-11 items-center gap-3 border-b border-edge px-4">
          <div className="h-5 w-5 rounded bg-edge-strong" />
          <div className="h-2 w-14 rounded-full bg-edge-strong" />
          <div className="h-2 w-10 rounded-full bg-edge-strong" />
        </div>
        <div className="space-y-3 p-5">
          <div className="h-5 w-3/4 rounded bg-edge-strong" />
          <div className="h-2 w-full rounded-full bg-hover" />
          <div className="h-2 w-5/6 rounded-full bg-hover" />
          <div className="relative pt-3">
            {accent && (
              <>
                <span className="absolute -inset-2 z-10 rounded-lg border-2 border-dashed border-red-500 bg-red-500/10" />
                <span className="absolute -top-5 right-0 z-20 rounded border border-red-300 bg-red-100 px-1.5 py-0.5 text-2xs font-bold text-red-800 shadow">
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

/** A run's status icon, coloured exactly as the app's status badges. */
function RunStatusIcon({ status }: { status: RunStatus }) {
  const style = statusStyle(status);
  const Icon = style.icon;
  return <Icon className={cn("h-4 w-4 shrink-0", style.text)} />;
}
