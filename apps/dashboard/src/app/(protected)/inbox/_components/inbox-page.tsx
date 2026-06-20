"use client";

import type { InboxStatusFilter, InboxWindowFilter } from "@furan/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ClusterBlock } from "./cluster-block";
import { groupIntoClusters, type ClusterGroup } from "./cluster-grouping";
import { EmptyState } from "./empty-state";
import { FilterBar } from "./filter-bar";
import { InboxPreviewPane } from "./inbox-preview-pane";
import { Pagination } from "./pagination";
import { RejectClusterDialog } from "./reject-cluster-dialog";

import { useCurrentProject } from "@/app/(protected)/_components/current-project-provider";
import { KeyboardScope } from "@/components/triage/keyboard-scope";
import { QueueRow } from "@/components/triage/queue-row";
import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { InboxRealtime } from "@/hooks/InboxRealtime";
import { plural } from "@/lib/format";
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
  const { currentProjectId } = useCurrentProject();

  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const actionsCountRef = useRef(0);
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  const list = trpc.inbox.list.useQuery(
    {
      status: initialStatus,
      window: initialWindow,
      cursor,
      group: initialGroup ? "similarity" : undefined,
      projectIds: currentProjectId ? [currentProjectId] : undefined,
    },
    { enabled: !!currentProjectId },
  );
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
          : `Rejected ${res.rejected} run${plural(res.rejected)} across ${res.buildCount} build${plural(res.buildCount)}`,
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

  // Reset the keyboard selection when the filter/group changes — FilterBar
  // navigates via router.replace (no remount), so this component persists while
  // `items` reshapes; a stale selectedIndex would point the highlight + a/r at a
  // run the user never selected.
  useEffect(() => {
    setSelectedIndex(0);
  }, [initialStatus, initialWindow, initialGroup]);

  // Keep the selection in range when the list shrinks — an approve/reject
  // refetch removes the acted-on run, or a shorter page loads. Without this a
  // stale index past the new end leaves `current` undefined: the preview blanks
  // and a/r no-op even though runs remain. Clamping lands on the new last row.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

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

  if (!currentProjectId) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-10 text-center text-sm text-zinc-500"
        data-testid="inbox-no-project"
      >
        No project selected. Create or choose a project to see its open runs.
      </div>
    );
  }

  return (
    <KeyboardScope
      // While the reject-cluster dialog is open, suppress the row shortcuts so a
      // stray a/r/j/k can't fire a single-run mutation on the row behind the modal.
      bindings={
        rejectTarget
          ? {}
          : {
              ArrowDown: () => moveSelection(1),
              ArrowUp: () => moveSelection(-1),
              j: () => moveSelection(1),
              k: () => moveSelection(-1),
              a: () => current && fireAction("approve", current, true),
              r: () => current && fireAction("reject", current, true),
            }
      }
    >
      <InboxRealtime />
      <PageContainer fullBleed>
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
        <div className="flex min-h-0 flex-1">
          {/* Left — the queue (full-width on narrow; fixed column on md+). */}
          <div className="flex min-h-0 w-full flex-col md:w-[380px] md:border-r md:border-zinc-200 lg:w-[420px] dark:md:border-zinc-900">
            {list.isLoading ? (
              <SkeletonList />
            ) : items.length === 0 ? (
              <EmptyState />
            ) : initialGroup ? (
              <ul
                id="inbox-queue-list"
                role="list"
                className="min-h-0 flex-1 overflow-y-auto"
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
                          onSelect={() => setSelectedIndex(idx)}
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
                        onApprove={(row) => fireAction("approve", row, false)}
                        onReject={(row) => fireAction("reject", row, false)}
                        onRejectAll={setRejectTarget}
                        onSelect={setSelectedIndex}
                      />
                    );
                  });
                })()}
              </ul>
            ) : (
              <ul
                id="inbox-queue-list"
                role="list"
                className="min-h-0 flex-1 overflow-y-auto"
              >
                {items.map((row, idx) => (
                  <QueueRow
                    key={row.runId}
                    row={row}
                    selected={idx === selectedIndex}
                    onApprove={() => fireAction("approve", row, false)}
                    onReject={() => fireAction("reject", row, false)}
                    onSelect={() => setSelectedIndex(idx)}
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
          </div>
          {/* Right — preview (md+ only; the queue's own open-diff link covers narrow). */}
          <div
            id="inbox-preview-pane"
            className="hidden min-h-0 flex-1 md:flex"
          >
            <InboxPreviewPane
              run={current}
              onApprove={() => current && fireAction("approve", current, false)}
              onReject={() => current && fireAction("reject", current, false)}
              isActing={approve.isPending || reject.isPending}
            />
          </div>
        </div>
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
      </PageContainer>
    </KeyboardScope>
  );
}

function SkeletonList() {
  return (
    <ul role="list" aria-busy="true" className="min-h-0 flex-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-900"
        >
          <Skeleton className="h-4 w-4" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-10 w-16" />
        </li>
      ))}
    </ul>
  );
}
