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
      className="flex flex-col gap-4 p-8 m-4 rounded-xl border border-dashed border-zinc-200 bg-zinc-50 max-w-2xl text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-300"
      data-testid="empty-run-card"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-2xl">
          📝
        </span>
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-white">
          No visual checks recorded
        </h2>
      </div>
      <p className="text-zinc-600 dark:text-zinc-400">
        This run completed successfully, but your test didn&apos;t capture any
        screenshots. To compare visuals on every run, add{" "}
        <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
          furan.snapshot()
        </code>{" "}
        calls inside your tests:
      </p>
      <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-100 text-zinc-800 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
        {`furan.snapshot("checkout-page")
furan.snapshot("checkout-modal", mask = listOf("[data-test=timer]"))`}
      </pre>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link
          href="https://github.com/qasecret/furan-monorepo#sdk"
          target="_blank"
          rel="noreferrer noopener"
          className="text-brand hover:underline"
          data-testid="empty-run-card-sdk-docs"
        >
          View SDK docs →
        </Link>
        {buildId && (
          <Link
            href={`/projects/${projectId}/runs?buildId=${buildId}`}
            className="text-brand hover:underline"
            data-testid="empty-run-card-timeline"
          >
            View run timeline →
          </Link>
        )}
      </div>
    </div>
  );
}
