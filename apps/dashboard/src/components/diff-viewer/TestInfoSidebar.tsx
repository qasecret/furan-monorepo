"use client";

import { History, Info, MessageSquare } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { DiffRegion } from "./layers/regionTypes";
import { RegionListPanel } from "./RegionListPanel";
import { RunCommentPanel } from "./RunCommentPanel";
import { useViewerStore } from "./useViewerStore";

import { cn } from "@/lib/cn";
import { formatBatchDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";

type Tab = "info" | "history" | "comments";

export interface TestInfoSidebarProps {
  /** TEST DETAILS */
  test: string;
  stepLabel: string | null;
  match: string | null;
  app: string | null;
  branch: string | null;
  /** ENVIRONMENT */
  os: string | null;
  browser: string | null;
  viewport: string | null;
  /** EXECUTION */
  startedAt: string | Date | null;
  duration: string | null;
  runBy: string | null;
  /** INFO → detected changes */
  regions: DiffRegion[];
  vlmDescription: string | null;
  /** HISTORY */
  testVariationId: string | null;
  currentBaselineKey: string | null;
  /** COMMENTS */
  runId: string;
}

const TABS: { id: Tab; label: string; Icon: typeof Info }[] = [
  { id: "info", label: "Info", Icon: Info },
  { id: "history", label: "History", Icon: History },
  { id: "comments", label: "Comments", Icon: MessageSquare },
];

function cap(value: string | null): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function val(value: string | null | undefined): string {
  return value && value.trim() ? value : "—";
}

/** One label/value pair in a metadata grid. */
function Row({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd
        className={cn(
          "truncate text-zinc-900 dark:text-white",
          mono && "font-mono text-xs",
        )}
      >
        {children}
      </dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 font-mono text-xs uppercase tracking-wider text-zinc-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * Right-hand contextual sidebar for the diff viewer, modelled on the
 * reference TestStep panel: INFO / HISTORY / COMMENTS tabs.
 *
 * - INFO surfaces Test Details, Environment and Execution metadata plus the
 *   functional detected-changes list (RegionListPanel, which still drives the
 *   canvas selection + region-kind editing).
 * - HISTORY shows the accepted-baseline timeline for the checkpoint's variation.
 * - COMMENTS embeds the per-run comment editor.
 *
 * The COMMENTS tab is wired to the viewer store's `commentPanelOpen` flag so
 * the ApprovalBar's "Comment" button focuses this tab.
 */
export function TestInfoSidebar({
  test,
  stepLabel,
  match,
  app,
  branch,
  os,
  browser,
  viewport,
  startedAt,
  duration,
  runBy,
  regions,
  vlmDescription,
  testVariationId,
  currentBaselineKey,
  runId,
}: TestInfoSidebarProps) {
  const [tab, setTab] = useState<Tab>("info");
  const commentRequested = useViewerStore((s) => s.commentPanelOpen);
  const setCommentRequested = useViewerStore((s) => s.setCommentPanelOpen);

  // ApprovalBar's "Comment" button flips commentPanelOpen → focus this tab.
  useEffect(() => {
    if (commentRequested) setTab("comments");
  }, [commentRequested]);

  const selectTab = (next: Tab) => {
    setTab(next);
    if (next !== "comments" && commentRequested) setCommentRequested(false);
  };

  return (
    <aside
      className="flex w-80 shrink-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
      data-testid="test-info-sidebar"
    >
      <div className="flex items-center border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map(({ id, label, Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => selectTab(id)}
              data-testid={`info-tab-${id}`}
              aria-pressed={active}
              className={cn(
                "flex-1 border-b-2 py-3 text-xs font-medium uppercase tracking-wider transition-colors",
                active
                  ? "border-[color:var(--color-brand)] text-zinc-900 dark:text-white"
                  : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300",
              )}
            >
              <Icon className="mx-auto mb-1 h-4 w-4" aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "info" && (
          <div className="space-y-6">
            <Section title="Test Details">
              <dl className="grid grid-cols-[88px_1fr] gap-y-2 text-sm">
                <Row label="Test">
                  <span className="font-medium">{val(test)}</span>
                </Row>
                <Row label="Step">{val(stepLabel)}</Row>
                <Row label="Match">{cap(match)}</Row>
                <Row label="App">{val(app)}</Row>
                <Row label="Branch" mono>
                  {val(branch)}
                </Row>
              </dl>
            </Section>

            <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

            <Section title="Environment">
              <dl className="grid grid-cols-[88px_1fr] gap-y-2 text-sm">
                <Row label="OS">{val(os)}</Row>
                <Row label="Browser">{val(browser)}</Row>
                <Row label="Viewport" mono>
                  {val(viewport)}
                </Row>
              </dl>
            </Section>

            <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

            <Section title="Execution">
              <dl className="grid grid-cols-[88px_1fr] gap-y-2 text-sm">
                <Row label="Started">
                  {startedAt ? formatBatchDateTime(startedAt) : "—"}
                </Row>
                <Row label="Duration" mono>
                  {val(duration)}
                </Row>
                <Row label="Run by">{val(runBy)}</Row>
              </dl>
            </Section>

            <div className="h-px bg-zinc-200 dark:bg-zinc-800" />

            <Section title="Detected changes">
              <RegionListPanel
                regions={regions}
                vlmDescription={vlmDescription}
              />
            </Section>
          </div>
        )}

        {tab === "history" && (
          <HistoryTab
            testVariationId={testVariationId}
            currentBaselineKey={currentBaselineKey}
          />
        )}

        {tab === "comments" && <RunCommentPanel runId={runId} embedded />}
      </div>
    </aside>
  );
}

/**
 * Accepted-baseline timeline for the checkpoint's variation — the reference
 * "History" tab. Fetches lazily (only while the tab is mounted) and renders a
 * connected dot/line timeline newest-first.
 */
function HistoryTab({
  testVariationId,
  currentBaselineKey,
}: {
  testVariationId: string | null;
  currentBaselineKey: string | null;
}) {
  const { data, isLoading } = trpc.baselines.listForVariation.useQuery(
    { testVariationId: testVariationId ?? "" },
    { enabled: !!testVariationId },
  );

  if (!testVariationId) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        History will appear once a baseline is accepted for this checkpoint.
      </p>
    );
  }
  if (isLoading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }
  if (!data || data.items.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No accepted baselines yet.
      </p>
    );
  }

  return (
    <ul role="list" className="space-y-0" data-testid="info-history-list">
      {data.items.map((b, i) => {
        const isCurrent =
          currentBaselineKey !== null && b.baselineName === currentBaselineKey;
        const last = i === data.items.length - 1;
        return (
          <li
            key={b.id}
            className="flex gap-3"
            data-testid={`info-history-row-${b.id}`}
          >
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                  isCurrent
                    ? "bg-[color:var(--color-brand)]"
                    : "bg-zinc-300 dark:bg-zinc-700",
                )}
                aria-hidden
              />
              {!last && (
                <span className="my-1 w-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              )}
            </div>
            <div className="pb-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-900 dark:text-white">
                  {b.isAuto
                    ? "System (auto-approved)"
                    : (b.approverEmail ?? "Unknown")}
                </span>
                {isCurrent && (
                  <span className="rounded-full bg-[color:var(--color-brand)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-brand)]">
                    current
                  </span>
                )}
              </div>
              <div className="mt-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                {formatBatchDateTime(b.createdAt)} · {b.branchName}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
