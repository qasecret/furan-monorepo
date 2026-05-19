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
      className="flex flex-col gap-4 p-8 m-4 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 max-w-2xl"
      data-testid="empty-run-card"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-2xl">
          📝
        </span>
        <h2 className="text-lg font-medium">No visual checks recorded</h2>
      </div>
      <p className="text-sm text-neutral-700">
        This run completed successfully, but your test didn&apos;t capture any
        screenshots. To compare visuals on every run, add{" "}
        <code className="font-mono text-xs">furan.snapshot()</code> calls inside
        your tests:
      </p>
      <pre className="overflow-x-auto rounded bg-neutral-900 text-neutral-100 p-3 text-xs">
        {`furan.snapshot("checkout-page")
furan.snapshot("checkout-modal", mask = listOf("[data-test=timer]"))`}
      </pre>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link
          href="https://github.com/qasecret/furan-monorepo#sdk"
          target="_blank"
          rel="noreferrer noopener"
          className="text-blue-700 hover:underline"
          data-testid="empty-run-card-sdk-docs"
        >
          View SDK docs →
        </Link>
        {buildId && (
          <Link
            href={`/projects/${projectId}/runs?buildId=${buildId}`}
            className="text-blue-700 hover:underline"
            data-testid="empty-run-card-timeline"
          >
            View run timeline →
          </Link>
        )}
      </div>
    </div>
  );
}
