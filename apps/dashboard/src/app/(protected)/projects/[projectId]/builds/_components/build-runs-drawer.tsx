"use client";

import type { RunStatus } from "@furan/shared-types";
import Link from "next/link";

import { RunStatusBadge } from "@/components/run-status-badge";
import { trpc } from "@/lib/trpc";

interface RunItem {
  id: string;
  branchName: string | null;
  status: RunStatus;
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  createdAt: string | Date;
}

interface Props {
  projectId: string;
  buildId: string;
}

function relative(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

/**
 * Inline runs list rendered under an expanded BuildRow. Fetches via
 * `runs.list` with a `buildId` filter (Stage 1 of this feature added the
 * filter to the procedure). Capped at 25 here — the "Open full run list"
 * link drops the user into the unbounded /runs?buildId=… view for more.
 */
export function BuildRunsDrawer({ projectId, buildId }: Props) {
  const { data, isLoading, error } = trpc.runs.list.useQuery({
    projectId,
    buildId,
    limit: 25,
  });

  if (isLoading) {
    return (
      <div className="px-6 py-3 text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (error) {
    return (
      <div className="px-6 py-3 text-sm text-destructive">
        Error: {error.message}
      </div>
    );
  }
  const items = (data?.items as unknown as RunItem[] | undefined) ?? [];

  return (
    <div
      className="bg-neutral-50 px-6 py-3 space-y-2"
      data-testid={`build-runs-drawer-${buildId}`}
    >
      {items.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No runs in this build.
        </div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="py-1 pr-2">
                  <Link
                    href={`/projects/${projectId}/runs/${r.id}/diffs/${r.id}`}
                    className="hover:underline"
                  >
                    {r.branchName ?? "—"}
                  </Link>
                </td>
                <td className="py-1 pr-2">
                  <RunStatusBadge status={r.status} />
                </td>
                <td className="py-1 pr-2">
                  {r.diffPercent !== null
                    ? `${r.diffPercent.toFixed(2)}%`
                    : "—"}
                </td>
                <td className="py-1 pr-2 text-muted-foreground">
                  {relative(r.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Link
        href={`/projects/${projectId}/runs?buildId=${buildId}`}
        className="text-xs text-blue-700 hover:underline"
      >
        Open full run list for this build →
      </Link>
    </div>
  );
}
