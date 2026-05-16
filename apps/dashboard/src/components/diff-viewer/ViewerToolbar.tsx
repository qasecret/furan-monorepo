"use client";

import { useViewerStore, type ViewerMode } from "./useViewerStore";

import { Slider } from "@/components/ui/slider";
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
  const opacity = useViewerStore((s) => s.opacity);
  const setOpacity = useViewerStore((s) => s.setOpacity);

  const showSlider = mode === "overlay" || mode === "onion-skin";
  const sliderLabel =
    mode === "onion-skin" ? "Baseline ↔ Candidate" : "Candidate opacity";

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
      {showSlider && (
        <div
          className="flex items-center gap-2 min-w-[200px]"
          data-testid="opacity-slider-wrap"
        >
          <span className="text-xs text-muted-foreground">{sliderLabel}</span>
          <Slider
            value={[Math.round(opacity * 100)]}
            onValueChange={([v]) => setOpacity((v ?? 0) / 100)}
            min={0}
            max={100}
            step={1}
            className="w-32"
            aria-label={sliderLabel}
          />
        </div>
      )}
    </div>
  );
}
