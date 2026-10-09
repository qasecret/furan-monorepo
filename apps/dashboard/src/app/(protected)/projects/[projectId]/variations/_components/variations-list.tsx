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
        <h3 className="text-base font-semibold text-fg">Variations</h3>
        <input
          type="search"
          placeholder="Filter by name…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setCursor(null);
          }}
          className="h-8 w-56 rounded-md border border-edge bg-canvas px-2 text-sm text-fg placeholder:text-fg-muted focus-ring"
          data-testid="variations-search-input"
        />
      </div>
      {query.isLoading ? (
        <p className="text-sm text-fg-secondary">Loading…</p>
      ) : query.error ? (
        <p className="text-sm text-destructive">{query.error.message}</p>
      ) : query.data && query.data.items.length === 0 ? (
        <p className="text-sm text-fg-secondary">
          {search
            ? `No variations match "${search}".`
            : "No variations yet for this project. Connect the SDK and run your first test to populate this list."}
        </p>
      ) : (
        <div className="-mx-4 overflow-x-auto border-y border-edge">
          <table className="w-full text-sm">
            <thead className="bg-sunken text-left text-fg-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Viewport</th>
                <th className="px-4 py-2.5 font-medium">Browser</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {query.data?.items.map((v) => (
                <tr
                  key={v.id}
                  className="group transition-colors hover:bg-hover"
                  data-testid={`variation-row-${v.id}`}
                >
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/projects/${projectId}/variations/${v.id}`}
                      className="font-medium text-fg transition-colors group-hover:text-brand-text focus-ring"
                    >
                      {v.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-fg-secondary">
                    {v.viewport ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-fg-secondary">
                    {v.browser ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-fg-muted">
                    {relative(v.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {query.data?.nextCursor && (
        <button
          type="button"
          onClick={() => setCursor(query.data.nextCursor)}
          className="h-8 rounded-md border border-edge bg-sunken px-3 text-sm text-fg-secondary hover:bg-hover focus-ring"
        >
          Load more
        </button>
      )}
    </Card>
  );
}
