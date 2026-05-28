"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

/**
 * Chip-based filter. Lists distinct (key, value) pairs from
 * `builds.listProperties`. Selecting `key=value` AND-joins it into the
 * current filter; clicking an existing chip removes it.
 *
 * The "Clear" affordance is a bare `<button>` styled like a text link
 * rather than `<Button variant="ghost" size="sm">` because the shared
 * Button component in this codebase doesn't expose a `ghost` variant or
 * a `size` prop.
 */
export function PropertiesFilter({ projectId, value, onChange }: Props) {
  const [draft, setDraft] = useState("");
  const { data } = trpc.builds.listProperties.useQuery({ projectId });

  const add = (key: string, val: string) => {
    onChange({ ...value, [key]: val });
  };
  const remove = (key: string) => {
    const { [key]: _drop, ...rest } = value;
    onChange(rest);
  };

  const allPairs: { key: string; value: string }[] = [];
  for (const { key, values } of data ?? []) {
    for (const v of values) allPairs.push({ key, value: v });
  }
  const filteredPairs = draft
    ? allPairs.filter((p) =>
        `${p.key}=${p.value}`.toLowerCase().includes(draft.toLowerCase()),
      )
    : allPairs.slice(0, 20);

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="properties-filter"
    >
      {Object.entries(value).map(([k, v]) => (
        <Badge
          key={k}
          variant="secondary"
          className="cursor-pointer"
          onClick={() => remove(k)}
          data-testid={`property-chip-active-${k}`}
        >
          {k}={v} ×
        </Badge>
      ))}
      <div className="relative">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Filter by property…"
          className="w-56"
          data-testid="properties-filter-input"
        />
        {draft && filteredPairs.length > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded-md border border-zinc-200 bg-white shadow-lg max-h-60 overflow-auto dark:border-zinc-800 dark:bg-zinc-950">
            {filteredPairs.slice(0, 20).map((p) => (
              <button
                key={`${p.key}=${p.value}`}
                onClick={() => {
                  add(p.key, p.value);
                  setDraft("");
                }}
                className="block w-full text-left px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-white"
                data-testid={`property-suggestion-${p.key}-${p.value}`}
              >
                {p.key}={p.value}
              </button>
            ))}
          </div>
        )}
      </div>
      {Object.keys(value).length > 0 && (
        <button
          type="button"
          onClick={() => onChange({})}
          className="text-sm text-zinc-600 hover:text-zinc-900 hover:underline px-2 py-1 transition-colors dark:text-zinc-400 dark:hover:text-white"
          data-testid="properties-filter-clear"
        >
          Clear
        </button>
      )}
    </div>
  );
}
