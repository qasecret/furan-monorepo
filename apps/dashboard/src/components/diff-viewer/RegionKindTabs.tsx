"use client";
import type { RegionKindTab } from "./useViewerStore";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const KINDS = [
  { value: "ignore", label: "Ignore", enforced: true },
  { value: "layout", label: "Layout", enforced: false },
  { value: "content", label: "Content", enforced: false },
] as const satisfies ReadonlyArray<{
  value: RegionKindTab;
  label: string;
  enforced: boolean;
}>;

/**
 * The set of `RegionKindTab` values that are not yet functional and must
 * not appear in the rendered tab list. The `RegionKindTab` union type in
 * `useViewerStore` is kept intact for forward-compat; we only suppress them
 * at render time.
 */
const HIDDEN_KINDS = new Set<RegionKindTab>(["floating", "accessibility"]);

export function RegionKindTabs({
  value,
  onChange,
}: {
  value: RegionKindTab;
  onChange: (k: RegionKindTab) => void;
}) {
  // Defensive fallback: if the active tab is a hidden kind (e.g. persisted
  // in store state from a previous session), treat it as "ignore" so the UI
  // never highlights a tab that isn't visible.
  const effectiveValue = HIDDEN_KINDS.has(value) ? "ignore" : value;

  return (
    <Tabs
      value={effectiveValue}
      onValueChange={(v) => onChange(v as RegionKindTab)}
    >
      <TabsList>
        {KINDS.map((k) => (
          <TabsTrigger key={k.value} value={k.value} className="relative">
            {k.label}
            {!k.enforced ? (
              <span
                className="ml-1 rounded bg-zinc-200 px-1 text-[10px] uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 cursor-help"
                title="Regions are saved but won't affect pass/fail status yet"
              >
                preview
              </span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
