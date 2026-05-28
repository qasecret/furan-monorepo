"use client";

import { trpc } from "@/lib/trpc";

/**
 * Sidebar badge showing the total count of open (unresolved + failed) inbox
 * items across all projects the current user is a member of.
 *
 * Polls every 60 s as a safety-net fallback; SSE-driven invalidation will be
 * wired in Task 19 and will supersede the need for polling in most sessions.
 */
export function InboxBadge() {
  const { data } = trpc.inbox.count.useQuery({}, { refetchInterval: 60_000 });
  const total = data?.total ?? 0;
  if (total === 0) return null;
  return (
    <span
      className="ml-auto rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200"
      aria-label={`${total} open runs`}
    >
      <span aria-hidden="true">{total > 99 ? "99+" : total}</span>
    </span>
  );
}
