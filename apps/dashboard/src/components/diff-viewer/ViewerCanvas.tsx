"use client";

import { Application } from "pixi.js";
import { useEffect, useRef } from "react";

import { mountImageLayer } from "./layers/ImageLayer";
import { useViewerStore } from "./useViewerStore";

interface Props {
  baselineUrl: string | null;
  candidateUrl: string | null;
}

export function ViewerCanvas({ baselineUrl, candidateUrl }: Props) {
  const baselineRef = useRef<HTMLDivElement>(null);
  const candidateRef = useRef<HTMLDivElement>(null);
  const mode = useViewerStore((s) => s.mode);

  useEffect(() => {
    if (mode !== "side-by-side") return;
    const baselineApp = new Application();
    const candidateApp = new Application();
    let cancelled = false;

    (async () => {
      await baselineApp.init({
        width: 600,
        height: 400,
        backgroundColor: 0xffffff,
      });
      await candidateApp.init({
        width: 600,
        height: 400,
        backgroundColor: 0xffffff,
      });
      if (cancelled) return;
      baselineRef.current?.appendChild(baselineApp.canvas);
      candidateRef.current?.appendChild(candidateApp.canvas);

      if (baselineUrl) await mountImageLayer(baselineApp, baselineUrl);
      if (candidateUrl) await mountImageLayer(candidateApp, candidateUrl);
    })();

    return () => {
      cancelled = true;
      baselineApp.destroy(true, { children: true, texture: true });
      candidateApp.destroy(true, { children: true, texture: true });
    };
  }, [mode, baselineUrl, candidateUrl]);

  if (mode === "side-by-side") {
    return (
      <div className="grid grid-cols-2 gap-2 p-2">
        <div className="border rounded">
          <div className="text-xs text-muted-foreground p-1 border-b">
            Baseline
          </div>
          <div ref={baselineRef} data-testid="baseline-canvas-host" />
        </div>
        <div className="border rounded">
          <div className="text-xs text-muted-foreground p-1 border-b">
            Candidate
          </div>
          <div ref={candidateRef} data-testid="candidate-canvas-host" />
        </div>
      </div>
    );
  }
  return (
    <div className="p-4 text-muted-foreground">
      Mode &quot;{mode}&quot; will be implemented in T9
    </div>
  );
}
