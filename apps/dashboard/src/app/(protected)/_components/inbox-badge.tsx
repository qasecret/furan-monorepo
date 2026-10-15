"use client";

import { useCurrentProject } from "./current-project-provider";

import { trpc } from "@/lib/trpc";

/**
 * Needs-review badge on the sidebar's Batches item: how many of the current
 * project's batches have at least one step waiting for review (the same rule
 * as the Needs review chip, `builds.pendingCount`). It counts batches, not
 * steps, and hides at 0.
 *
 * Polls every 60 s as a safety net; the review loop also invalidates it after
 * every decision or undo. When no project is selected the badge is suppressed
 * entirely.
 */
export function InboxBadge() {
  const { currentProjectId } = useCurrentProject();
  const { data } = trpc.builds.pendingCount.useQuery(
    { projectId: currentProjectId ?? "" },
    { refetchInterval: 60_000, enabled: !!currentProjectId },
  );
  const total = data?.total ?? 0;
  if (total === 0) return null;
  // The visible number is capped; screen readers get the full count as text
  // (an aria-label on a generic span is not announced), which also joins the
  // name of the link the badge sits in.
  return (
    <span className="ml-auto rounded-full bg-edge px-1.5 py-0.5 text-2xs font-medium tabular-nums text-fg-secondary">
      <span aria-hidden="true">{total > 99 ? "99+" : total}</span>
      <span className="sr-only">
        {`${total} ${total === 1 ? "batch needs" : "batches need"} review`}
      </span>
    </span>
  );
}
