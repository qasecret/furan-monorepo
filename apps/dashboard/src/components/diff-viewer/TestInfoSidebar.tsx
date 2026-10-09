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
  /** INFO → summary stat cards + detected changes */
  pixelDiffPercent: number | null;
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

const SEV_RANK: Record<string, number> = {
  breaking: 4,
  major: 3,
  minor: 2,
  cosmetic: 1,
  none: 0,
};
const SEV_LABEL: Record<string, string> = {
  breaking: "Breaking",
  major: "Major",
  minor: "Minor",
  cosmetic: "Cosmetic",
  none: "None",
};
// Worst-severity chip. Hues mirror RegionItem's SEVERITY_STYLE badges
// (breaking red → major orange → minor yellow → cosmetic blue → none green)
// so the card speaks the same colour language as the region rows below.
// Severity is not a run status, so it is the same opaque pastel chip in both
// themes: a bare hue text shade can't reach AA on both a light and a dark card.
const SEV_COLOR: Record<string, string> = {
  breaking: "rounded-md bg-red-100 px-1.5 text-red-800",
  major: "rounded-md bg-orange-100 px-1.5 text-orange-800",
  minor: "rounded-md bg-yellow-100 px-1.5 text-yellow-800",
  cosmetic: "rounded-md bg-blue-100 px-1.5 text-blue-800",
  none: "rounded-md bg-emerald-100 px-1.5 text-emerald-800",
};

function worstSeverity(regions: DiffRegion[]): string {
  let worst = "none";
  for (const r of regions) {
    if ((SEV_RANK[r.severity] ?? 0) > (SEV_RANK[worst] ?? 0))
      worst = r.severity;
  }
  return worst;
}

/** A single summary stat card (value over a small uppercase label). */
function StatCard({
  value,
  label,
  valueClass,
}: {
  value: ReactNode;
  label: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg bg-raised px-2 py-2.5 shadow-raised">
      <span className={cn("text-base font-semibold tabular-nums", valueClass)}>
        {value}
      </span>
      <span className="mt-0.5 font-mono text-2xs uppercase tracking-wider text-fg-muted">
        {label}
      </span>
    </div>
  );
}

/**
 * Three at-a-glance summary cards atop the INFO tab (modelled on the
 * step panel): pixel-diff %, region count, worst severity.
 */
function StatCards({
  pixelDiffPercent,
  regions,
}: {
  pixelDiffPercent: number | null;
  regions: DiffRegion[];
}) {
  const sev = worstSeverity(regions);
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="info-stat-cards">
      <StatCard
        value={
          pixelDiffPercent != null ? `${pixelDiffPercent.toFixed(2)}%` : "—"
        }
        label="Pixel diff"
        valueClass={
          pixelDiffPercent
            ? "font-mono text-destructive"
            : "font-mono text-fg-muted"
        }
      />
      <StatCard
        value={regions.length}
        label="Regions"
        valueClass={
          regions.length ? "font-mono text-fg" : "font-mono text-fg-muted"
        }
      />
      <StatCard
        value={SEV_LABEL[sev] ?? "None"}
        label="Severity"
        valueClass={SEV_COLOR[sev] ?? SEV_COLOR.none}
      />
    </div>
  );
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
      <dt className="text-fg-muted">{label}</dt>
      <dd
        className={cn(
          "truncate text-fg",
          mono && "font-mono text-xs tabular-nums",
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
      <h3 className="mb-3 font-mono text-xs uppercase tracking-wider text-fg-muted">
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
  pixelDiffPercent,
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
      className="flex w-80 shrink-0 flex-col border-l border-edge bg-canvas"
      data-testid="test-info-sidebar"
    >
      <div className="flex items-center border-b border-edge">
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
                // Inset ring: the viewer body is overflow-hidden and would
                // clip the top of an outset one.
                "flex-1 border-b-2 py-3 text-xs font-medium uppercase tracking-wider transition-colors focus-ring focus-visible:-outline-offset-2",
                active
                  ? "border-brand text-fg"
                  : "border-transparent text-fg-muted hover:text-fg-secondary",
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
            <StatCards pixelDiffPercent={pixelDiffPercent} regions={regions} />

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

            <div className="h-px bg-edge" aria-hidden />

            <Section title="Environment">
              <dl className="grid grid-cols-[88px_1fr] gap-y-2 text-sm">
                <Row label="OS">{val(os)}</Row>
                <Row label="Browser">{val(browser)}</Row>
                <Row label="Viewport" mono>
                  {val(viewport)}
                </Row>
              </dl>
            </Section>

            <div className="h-px bg-edge" aria-hidden />

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

            <div className="h-px bg-edge" aria-hidden />

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
      <p className="text-sm text-fg-muted">
        History will appear once a baseline is accepted for this checkpoint.
      </p>
    );
  }
  if (isLoading) {
    return <p className="text-sm text-fg-muted">Loading…</p>;
  }
  if (!data || data.items.length === 0) {
    return <p className="text-sm text-fg-muted">No accepted baselines yet.</p>;
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
                  isCurrent ? "bg-brand" : "bg-edge-strong",
                )}
                aria-hidden
              />
              {!last && <span className="my-1 w-px flex-1 bg-edge" />}
            </div>
            <div className="pb-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-fg">
                  {b.isAuto
                    ? "System (auto-approved)"
                    : (b.approverEmail ?? "Unknown")}
                </span>
                {isCurrent && (
                  <span className="rounded-full bg-brand/20 px-1.5 py-0.5 text-2xs font-medium text-brand-text">
                    current
                  </span>
                )}
              </div>
              <div className="mt-0.5 font-mono text-xs tabular-nums text-fg-muted">
                {formatBatchDateTime(b.createdAt)} · {b.branchName}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
