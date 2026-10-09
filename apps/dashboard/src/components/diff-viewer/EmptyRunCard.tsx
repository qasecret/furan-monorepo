"use client";

import Link from "next/link";

interface Props {
  projectId: string;
  buildId?: string | null;
}

/**
 * Friendly explainer shown in place of the diff viewer when a run has
 * status="empty" — the test ran to completion but called no furan.snapshot().
 * Keeps the user oriented and points at the SDK instead of leaving them
 * staring at an empty canvas.
 */
export function EmptyRunCard({ projectId, buildId }: Props) {
  return (
    <div
      className="flex flex-col gap-4 p-8 m-4 rounded-xl border border-dashed border-edge-strong bg-sunken max-w-2xl text-sm text-fg-secondary"
      data-testid="empty-run-card"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-2xl">
          📝
        </span>
        <h2 className="text-lg font-semibold text-fg">
          No visual checks recorded
        </h2>
      </div>
      <p className="text-fg-secondary">
        This run completed successfully, but your test didn&apos;t capture any
        screenshots. To compare visuals on every run, add{" "}
        <code className="font-mono text-xs text-fg-secondary">
          furan.snapshot()
        </code>{" "}
        calls inside your tests:
      </p>
      <pre className="overflow-x-auto rounded-md border border-edge bg-raised text-fg p-3 text-xs">
        {`furan.snapshot("checkout-page")
furan.snapshot("checkout-modal", mask = listOf("[data-test=timer]"))`}
      </pre>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link
          href="https://github.com/qasecret/furan-monorepo#sdk"
          target="_blank"
          rel="noreferrer noopener"
          className="text-brand-text hover:underline focus-ring"
          data-testid="empty-run-card-sdk-docs"
        >
          View SDK docs →
        </Link>
        {buildId && (
          <Link
            href={`/projects/${projectId}/builds/${buildId}`}
            className="text-brand-text hover:underline focus-ring"
            data-testid="empty-run-card-timeline"
          >
            View build →
          </Link>
        )}
      </div>
    </div>
  );
}
