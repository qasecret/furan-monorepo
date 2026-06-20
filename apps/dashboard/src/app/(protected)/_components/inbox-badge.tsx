"use client";

import { useCurrentProject } from "./current-project-provider";

import { trpc } from "@/lib/trpc";

/**
 * Sidebar badge showing the count of open (unresolved + failed) inbox items
 * for the currently selected project.
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
      className="ml-auto rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
      aria-label={`${total} open runs`}
    >
      <span aria-hidden="true">{total > 99 ? "99+" : total}</span>
    </span>
  );
}
