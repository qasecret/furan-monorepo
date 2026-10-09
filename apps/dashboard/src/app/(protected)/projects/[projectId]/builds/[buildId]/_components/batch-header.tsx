"use client";

import { buildDisplayName } from "@/lib/build-display-name";
import { cn } from "@/lib/cn";
import { statusStyle } from "@/lib/status-style";
import type { RouterOutputs } from "@/lib/trpc";

export type BatchHeaderData = RouterOutputs["builds"]["getById"];

interface Props {
  build: BatchHeaderData;
}

/**
 * Formats the created→updated span as HH:MM:SS (the reference's Duration).
 * When the build was never updated after creation (equal timestamps) there's
 * no real run span, so we show "—" rather than a misleading 00:00:00 timer.
 */
function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!(ms > 0)) return "—";
  let secs = Math.round(ms / 1000);
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  secs -= m * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(secs)}`;
}

/**
 * One labelled meta group — "Tests: 1 in total | 0 unresolved | 1 new".
 * `data` sets the values in the data face (mono, tabular), e.g. a duration.
 */
function MetaGroup({
  label,
  parts,
  data = false,
}: {
  label: string;
  parts: string[];
  data?: boolean;
}) {
  return (
    <span className="whitespace-nowrap text-xs">
      <span className="font-semibold text-fg">{label}:</span>{" "}
      <span className={cn("tabular-nums text-fg-muted", data && "font-mono")}>
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 && (
              <span aria-hidden className="px-1.5 text-edge-strong">
                |
              </span>
            )}
            {p}
          </span>
        ))}
      </span>
    </span>
  );
}

function Bullet() {
  return (
    <span aria-hidden className="text-edge-strong">
      •
    </span>
  );
}

export function BatchHeader({ build }: Props) {
  const status = statusStyle(build.aggregateStatus);

  return (
    <header id="batch-header" className="border-b border-edge px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span
            aria-hidden
            className={cn("mt-0.5 h-9 w-1 shrink-0 rounded-full", status.dot)}
          />
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-baseline gap-x-2 text-base font-semibold tracking-tight">
              <span className={status.text}>{status.label}</span>
              <span className="text-fg">
                <span className="font-normal text-fg-muted">
                  Test results of batch:{" "}
                </span>
                {buildDisplayName(build)}
              </span>
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <MetaGroup
                label="Tests"
                parts={[
                  `${build.runCount} in total`,
                  `${build.unresolvedCount} unresolved`,
                  ...(build.newCount != null ? [`${build.newCount} new`] : []),
                ]}
              />
              {build.stepsTotal != null && (
                <>
                  <Bullet />
                  <MetaGroup
                    label="Steps"
                    parts={[`${build.stepsTotal} in total`]}
                  />
                </>
              )}
              <Bullet />
              <MetaGroup
                label="Duration"
                parts={[formatDuration(build.createdAt, build.updatedAt)]}
                data
              />
              <Bullet />
              <MetaGroup label="Run by" parts={[build.runByName ?? "—"]} />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
