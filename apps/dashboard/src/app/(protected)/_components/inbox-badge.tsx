"use client";

import { useCurrentProject } from "./current-project-provider";

import { trpc } from "@/lib/trpc";

/**
 * Open-count badge (unresolved + failed inbox items for the currently selected
 * project), rendered on the view selector's Inbox item.
 *
 * Polls every 60 s as a safety-net fallback; SSE-driven invalidation will be
 * wired in Task 19 and will supersede the need for polling in most sessions.
 * When no project is selected the badge is suppressed entirely.
 */
export function InboxBadge() {
  const { currentProjectId } = useCurrentProject();
  const { data } = trpc.inbox.count.useQuery(
    { projectIds: currentProjectId ? [currentProjectId] : undefined },
    { refetchInterval: 60_000, enabled: !!currentProjectId },
  );
  const total = data?.total ?? 0;
  if (total === 0) return null;
  return (
    <span
      className="ml-auto rounded-full bg-edge px-1.5 py-0.5 text-2xs font-medium tabular-nums text-fg-secondary"
      aria-label={`${total} open runs`}
    >
      <span aria-hidden="true">{total > 99 ? "99+" : total}</span>
    </span>
  );
}
