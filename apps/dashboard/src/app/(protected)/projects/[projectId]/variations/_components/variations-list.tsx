"use client";

import Link from "next/link";
import { useState } from "react";

import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
}

function relative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

/**
 * Client-side variations browse list. Sits alongside MergeBaselinesPanel
 * on the /variations index page so reviewers don't have to drill through a
 * runs row to see what visual checkpoints the SDK has registered. Each
 * row deep-links into the existing /variations/[id] history page.
 *
 * Search is debounced inside the query input (useQuery refetches as the
 * value changes); the substring match runs server-side via the new
 * variations.list ILIKE filter. Pagination is "Load more" — there isn't
 * usually enough variation churn to warrant infinite scroll.
 */
export function VariationsList({ projectId }: Props) {
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const query = trpc.variations.list.useQuery({
    projectId,
    search: search || undefined,
    cursor: cursor ?? undefined,
    limit: 25,
  });

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
          Variations
        </h3>
        <input
          type="search"
          placeholder="Filter by name…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setCursor(null);
          }}
          className="h-8 w-56 rounded-md border border-zinc-200 bg-white px-2 text-sm text-zinc-900 placeholder:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-white"
          data-testid="variations-search-input"
        />
      </div>
      {query.isLoading ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</p>
      ) : query.error ? (
        <p className="text-sm text-red-500">{query.error.message}</p>
      ) : query.data && query.data.items.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {search
            ? `No variations match "${search}".`
            : "No variations yet for this project. Connect the SDK and run your first test to populate this list."}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-1.5">Name</th>
              <th className="py-1.5">Viewport</th>
              <th className="py-1.5">Browser</th>
              <th className="py-1.5">Created</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items.map((v) => (
              <tr
                key={v.id}
                className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/40"
                data-testid={`variation-row-${v.id}`}
              >
                <td className="py-2">
                  <Link
                    href={`/projects/${projectId}/variations/${v.id}`}
                    className="font-medium text-zinc-900 hover:underline dark:text-white"
                  >
                    {v.name}
                  </Link>
                </td>
                <td className="py-2 text-zinc-600 dark:text-zinc-400">
                  {v.viewport ?? "—"}
                </td>
                <td className="py-2 text-zinc-600 dark:text-zinc-400">
                  {v.browser ?? "—"}
                </td>
                <td className="py-2 text-zinc-500">{relative(v.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {query.data?.nextCursor && (
        <button
          type="button"
          onClick={() => setCursor(query.data.nextCursor)}
          className="h-8 rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900/70"
        >
          Load more
        </button>
      )}
    </Card>
  );
}
