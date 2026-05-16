"use client";

import { useViewerStore, type ViewerMode } from "./useViewerStore";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const MODES: { value: ViewerMode; label: string }[] = [
  { value: "side-by-side", label: "Side-by-side" },
  { value: "overlay", label: "Overlay" },
  { value: "onion-skin", label: "Onion-skin" },
  { value: "diff-heatmap", label: "Diff heatmap" },
];

export function ViewerToolbar() {
  const mode = useViewerStore((s) => s.mode);
  const setMode = useViewerStore((s) => s.setMode);

  return (
    <div className="flex items-center gap-4 p-2 border-b">
      <Tabs value={mode} onValueChange={(v) => setMode(v as ViewerMode)}>
        <TabsList>
          {MODES.map((m) => (
            <TabsTrigger key={m.value} value={m.value} data-mode={m.value}>
              {m.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
