"use client";

import type { InboxStatusFilter, InboxWindowFilter } from "@furan/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ClusterBlock } from "./cluster-block";
import { groupIntoClusters, type ClusterGroup } from "./cluster-grouping";
import { EmptyState } from "./empty-state";
import { FilterBar } from "./filter-bar";
import { Pagination } from "./pagination";
import { RejectClusterDialog } from "./reject-cluster-dialog";

import { KeyboardScope } from "@/components/triage/keyboard-scope";
import { QueueRow } from "@/components/triage/queue-row";
import { InboxRealtime } from "@/hooks/InboxRealtime";
import { recordTelemetry } from "@/lib/telemetry";
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
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const actionsCountRef = useRef(0);
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  const list = trpc.inbox.list.useQuery({
    status: initialStatus,
    window: initialWindow,
    cursor,
    group: initialGroup ? "similarity" : undefined,
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

  const [rejectTarget, setRejectTarget] = useState<ClusterGroup | null>(null);
  const rejectCluster = trpc.inbox.rejectCluster.useMutation({
    onSuccess: (res) => {
      const total = rejectTarget?.runCount ?? res.rejected;
      toast.success(
        res.capped
          ? `Rejected ${res.rejected} of ${total} runs (cap ${res.cap})`
          : `Rejected ${res.rejected} run${res.rejected === 1 ? "" : "s"} across ${res.buildCount} build${res.buildCount === 1 ? "" : "s"}`,
      );
      setRejectTarget(null);
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

  // Fire inbox.viewed once on mount with current filter state.
  useEffect(() => {
    recordTelemetry("inbox.viewed", {
      sessionId: sessionIdRef.current,
      filterStatus: initialStatus,
      filterWindow: initialWindow,
      groupBy: initialGroup,
      itemCount: items.length,
    });
  }, []); // intentionally empty — fires once per mount

  // Record session_duration on unmount.
  useEffect(() => {
    const startMs = Date.now();
    actionsCountRef.current = 0;
    return () => {
      recordTelemetry("inbox.session_duration", {
        sessionId: sessionIdRef.current,
        durationMs: Date.now() - startMs,
        actionsTaken: actionsCountRef.current,
      });
    };
  }, []); // intentionally empty — captures mount time, cleans up on unmount

  const fireAction = useCallback(
    (
      action: "approve" | "reject",
      row: (typeof items)[number],
      viaKeyboard: boolean,
    ) => {
      actionsCountRef.current += 1;
      recordTelemetry("inbox.row_action", {
        sessionId: sessionIdRef.current,
        action,
        viaKeyboard,
        rowAge: Math.floor(
          (Date.now() - new Date(row.createdAt).getTime()) / 1000,
        ),
      });
      if (action === "approve") {
        approve.mutate({ runId: row.runId });
      } else {
        reject.mutate({ runId: row.runId, reason: null });
      }
    },
    [approve, reject],
  );

  return (
    <KeyboardScope
      bindings={{
        ArrowDown: () => moveSelection(1),
        ArrowUp: () => moveSelection(-1),
        j: () => moveSelection(1),
        k: () => moveSelection(-1),
        a: () => current && fireAction("approve", current, true),
        r: () => current && fireAction("reject", current, true),
      }}
    >
      <InboxRealtime />
      <div className="flex h-full flex-col">
        <header
          id="inbox-header"
          className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-900"
        >
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            All open runs across your projects · Press{" "}
            <kbd
              id="inbox-shortcut-hint"
              className="rounded border border-zinc-200 bg-zinc-50 px-1 text-xs dark:border-zinc-800 dark:bg-zinc-900"
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
        ) : initialGroup ? (
          <ul
            id="inbox-queue-list"
            role="list"
            className="flex-1 overflow-y-auto"
          >
            {(() => {
              const groups = groupIntoClusters(items);
              let flat = 0;
              return groups.map((g) => {
                if (g.kind === "single") {
                  const idx = flat++;
                  return (
                    <QueueRow
                      key={g.row.runId}
                      row={g.row}
                      selected={idx === selectedIndex}
                      onApprove={() => fireAction("approve", g.row, false)}
                      onReject={() => fireAction("reject", g.row, false)}
                    />
                  );
                }
                const base = flat;
                flat += g.rows.length;
                return (
                  <ClusterBlock
                    key={`${g.projectId}:${g.signature}`}
                    cluster={g}
                    baseIndex={base}
                    selectedIndex={selectedIndex}
                    onApprove={(runId) =>
                      fireAction(
                        "approve",
                        items.find((r) => r.runId === runId)!,
                        false,
                      )
                    }
                    onReject={(runId) =>
                      fireAction(
                        "reject",
                        items.find((r) => r.runId === runId)!,
                        false,
                      )
                    }
                    onRejectAll={setRejectTarget}
                  />
                );
              });
            })()}
          </ul>
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
                onApprove={() => fireAction("approve", row, false)}
                onReject={() => fireAction("reject", row, false)}
              />
            ))}
          </ul>
        )}
        {rejectTarget && (
          <RejectClusterDialog
            open
            runCount={rejectTarget.runCount}
            buildCount={rejectTarget.buildCount}
            runNames={rejectTarget.rows.map((r) => r.variationName)}
            isPending={rejectCluster.isPending}
            onOpenChange={(o) => {
              if (!o) setRejectTarget(null);
            }}
            onConfirm={() =>
              rejectCluster.mutate({
                projectId: rejectTarget.projectId,
                signature: rejectTarget.signature,
                status: initialStatus,
                window: initialWindow,
              })
            }
          />
        )}
        <Pagination
          hasMore={
            list.data?.nextCursor !== null &&
            list.data?.nextCursor !== undefined
          }
          onNext={() => setCursor(list.data?.nextCursor ?? null)}
        />
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
          className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-900"
        >
          <div className="h-4 w-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-1/3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
          </div>
          <div className="h-10 w-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
        </li>
      ))}
    </ul>
  );
}
