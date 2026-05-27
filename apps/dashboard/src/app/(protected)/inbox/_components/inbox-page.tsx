"use client";

import type { InboxStatusFilter, InboxWindowFilter } from "@furan/shared-types";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "./empty-state";
import { FilterBar } from "./filter-bar";
import { Pagination } from "./pagination";

import { KeyboardScope } from "@/components/triage/keyboard-scope";
import { QueueRow } from "@/components/triage/queue-row";
import { ShortcutsDialog } from "@/components/triage/shortcuts-dialog";
import { useInboxRealtime } from "@/hooks/useInboxRealtime";
import { trpc } from "@/lib/trpc";

interface Props {
  initialStatus: InboxStatusFilter;
  initialWindow: InboxWindowFilter;
  initialGroup: boolean;
}

export function InboxPage({
  initialStatus,
  initialWindow,
  initialGroup,
}: Props) {
  useInboxRealtime();

  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const list = trpc.inbox.list.useQuery({
    status: initialStatus,
    window: initialWindow,
    cursor,
  });
  const approve = trpc.inbox.approve.useMutation({
    onSuccess: () => {
      toast.success("Approved");
      void list.refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const reject = trpc.inbox.reject.useMutation({
    onSuccess: () => {
      toast.success("Rejected");
      void list.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const items = list.data?.items ?? [];
  const current = items[selectedIndex];
  const moveSelection = useCallback(
    (delta: number) => {
      setSelectedIndex((i) =>
        Math.max(0, Math.min(items.length - 1, i + delta)),
      );
    },
    [items.length],
  );

  return (
    <KeyboardScope
      bindings={{
        ArrowDown: () => moveSelection(1),
        ArrowUp: () => moveSelection(-1),
        j: () => moveSelection(1),
        k: () => moveSelection(-1),
        a: () => current && approve.mutate({ runId: current.runId }),
        r: () =>
          current && reject.mutate({ runId: current.runId, reason: null }),
        "?": () => setShortcutsOpen(true),
        Escape: () => setShortcutsOpen(false),
      }}
    >
      <div className="flex h-full flex-col">
        <header
          id="inbox-header"
          className="border-b border-zinc-900 px-4 py-4"
        >
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-sm text-zinc-400">
            All open runs across your projects · Press{" "}
            <kbd
              id="inbox-shortcut-hint"
              className="rounded border border-zinc-800 bg-zinc-900 px-1 text-xs"
            >
              ?
            </kbd>{" "}
            for shortcuts
          </p>
        </header>
        <FilterBar
          status={initialStatus}
          window={initialWindow}
          groupBy={initialGroup}
        />
        {list.isLoading ? (
          <SkeletonList />
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <ul
            id="inbox-queue-list"
            role="list"
            className="flex-1 overflow-y-auto"
          >
            {items.map((row, idx) => (
              <QueueRow
                key={row.runId}
                row={row}
                selected={idx === selectedIndex}
                onApprove={() => approve.mutate({ runId: row.runId })}
                onReject={() =>
                  reject.mutate({ runId: row.runId, reason: null })
                }
              />
            ))}
          </ul>
        )}
        <Pagination
          hasMore={
            list.data?.nextCursor !== null &&
            list.data?.nextCursor !== undefined
          }
          onNext={() => setCursor(list.data?.nextCursor ?? null)}
        />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </KeyboardScope>
  );
}

function SkeletonList() {
  return (
    <ul role="list" aria-busy="true" className="flex-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-3 border-b border-zinc-900 px-4 py-3"
        >
          <div className="h-4 w-4 animate-pulse rounded bg-zinc-800" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-1/3 animate-pulse rounded bg-zinc-800" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-zinc-900" />
          </div>
          <div className="h-10 w-16 animate-pulse rounded bg-zinc-900" />
        </li>
      ))}
    </ul>
  );
}
