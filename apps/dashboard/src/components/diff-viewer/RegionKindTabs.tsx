"use client";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const KINDS = [
  { value: "ignore", label: "Ignore", enforced: true },
  { value: "layout", label: "Layout", enforced: false },
  { value: "floating", label: "Floating", enforced: false },
  { value: "content", label: "Content", enforced: false },
  { value: "accessibility", label: "A11y", enforced: false },
] as const;

export type RegionKind = (typeof KINDS)[number]["value"];

export function RegionKindTabs({
  value,
  onChange,
}: {
  value: RegionKind;
  onChange: (k: RegionKind) => void;
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as RegionKind)}>
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
