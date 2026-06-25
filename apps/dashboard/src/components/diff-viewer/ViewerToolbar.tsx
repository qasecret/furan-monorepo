"use client";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Layers,
  Maximize2,
  Minimize2,
  Pencil,
  SlidersHorizontal,
  SplitSquareHorizontal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { buildIgnoreAreasPayload } from "./ignore-area-payload";
import { setClipboardRegion, useClipboardRegion } from "./region-clipboard";
import { RegionSettingsPopover } from "./RegionSettingsPopover";
import { SensitivityControl } from "./SensitivityControl";
import type { DiffStepper } from "./useDiffStepper";
import {
  selectEffectiveRegion,
  useViewerStore,
  ZOOM_STEP,
  type ViewerMode,
} from "./useViewerStore";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { trpc } from "@/lib/trpc";

const MODES: { value: ViewerMode; label: string; Icon: typeof Layers }[] = [
  { value: "side-by-side", label: "Side by side", Icon: SplitSquareHorizontal },
  { value: "overlay", label: "Overlay", Icon: SlidersHorizontal },
  { value: "difference", label: "Diff only", Icon: Layers },
];

interface Props {
  /** The current run id — needed for the setIgnoreAreas mutation. */
  runId: string;
  /**
   * Project id — keys the per-project region clipboard. Optional so
   * existing call sites (and tests) that haven't threaded it yet still
   * compile; when empty the clipboard read/write is a no-op.
   */
  projectId?: string;
  /**
   * Project-scoped settings the toolbar needs. Currently only
   * `dynamicTextEnabled`, which gates the kind selector + PatternEditor.
   * Defaults to false when omitted so callers that haven't wired the flag
   * yet stay on the legacy "ignore-only" code path.
   */
  project?: {
    dynamicTextEnabled: boolean;
    /** Project default for the diff threshold (0-1). Used as the slider's
     * fallback when the run has no per-run override. */
    diffThreshold?: number | null;
  };
  /** Per-run override of the project's diff threshold (0-1, or null = inherit). */
  runDiffThresholdOverride?: number | null;
  /**
   * Whether the run's candidate screenshot has an element-map sidecar
   * captured. When false, the "Pick element" input toggle is disabled
   * with an explanatory title — the picker depends on the SDK's
   * PR-#61 element map.
   */
  hasElementMap?: boolean;
  /**
   * Diff stepper for stepping through diff regions. When provided,
   * renders prev/next controls and a counter in the toolbar.
   */
  stepper?: DiffStepper;
}

export function ViewerToolbar({
  runId,
  projectId = "",
  project,
  runDiffThresholdOverride = null,
  hasElementMap = false,
  stepper,
}: Props) {
  const dynamicTextEnabled = project?.dynamicTextEnabled ?? false;
  const mode = useViewerStore((s) => s.mode);
  const setMode = useViewerStore((s) => s.setMode);
  const opacity = useViewerStore((s) => s.opacity);
  const setOpacity = useViewerStore((s) => s.setOpacity);
  const zoom = useViewerStore((s) => s.zoom);
  const zoomBy = useViewerStore((s) => s.zoomBy);
  const resetZoom = useViewerStore((s) => s.resetZoom);

  const ignoreEditMode = useViewerStore((s) => s.ignoreEditMode);
  const setIgnoreEditMode = useViewerStore((s) => s.setIgnoreEditMode);
  const regionInputMode = useViewerStore((s) => s.regionInputMode);
  const setRegionInputMode = useViewerStore((s) => s.setRegionInputMode);
  const savedRunIgnoreAreas = useViewerStore((s) => s.savedRunIgnoreAreas);
  const savedVariationIgnoreAreas = useViewerStore(
    (s) => s.savedVariationIgnoreAreas,
  );
  const draftIgnoreAreas = useViewerStore((s) => s.draftIgnoreAreas);
  const markedForDeletion = useViewerStore((s) => s.markedForDeletion);
  const discardIgnoreChanges = useViewerStore((s) => s.discardIgnoreChanges);
  const applySaveSuccess = useViewerStore((s) => s.applySaveSuccess);
  const hideDisplacement = useViewerStore((s) => s.hideDisplacement);
  const setHideDisplacement = useViewerStore((s) => s.setHideDisplacement);
  const highlightActive = useViewerStore((s) => s.highlightActive);
  const setHighlightActive = useViewerStore((s) => s.setHighlightActive);
  const isTemporaryMode = useViewerStore((s) => s.isTemporaryMode);
  const setTemporaryMode = useViewerStore((s) => s.setTemporaryMode);
  const selectedIgnoreId = useViewerStore((s) => s.selectedIgnoreId);
  const paddingOverrides = useViewerStore((s) => s.paddingOverrides);
  const kindOverrides = useViewerStore((s) => s.kindOverrides);
  const thresholdOverrides = useViewerStore((s) => s.thresholdOverrides);
  const selectorOverrides = useViewerStore((s) => s.selectorOverrides);
  // Region clipboard wiring (Copy/Paste). `useClipboardRegion` subscribes
  // to same-tab + cross-tab clipboard events so the Paste button's
  // disabled state reflects the live clipboard.
  const clipboard = useClipboardRegion(projectId);
  const viewport = useViewerStore((s) => s.viewport);
  const addDraftRegion = useViewerStore((s) => s.addDraftRegion);

  // Fullscreen toggle for the diff-viewer root (reference TestStep toolbar).
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    const el = document.getElementById("diff-viewer-root");
    if (!document.fullscreenElement) {
      void el?.requestFullscreen?.();
    } else {
      void document.exitFullscreen?.();
    }
  };

  const utils = trpc.useUtils();
  const setIgnoreAreas = trpc.runs.setIgnoreAreas.useMutation({
    onSuccess: (_data, vars) => {
      applySaveSuccess(vars.scope);
      void utils.runs.getById.invalidate({ runId });
    },
  });
  const setTempIgnoreAreas = trpc.runs.setTempIgnoreAreas.useMutation({
    onSuccess: () => {
      discardIgnoreChanges();
      void utils.runs.getById.invalidate({ runId });
    },
  });

  const showSlider = mode === "overlay";
  const sliderLabel = "Candidate opacity";

  const editing = ignoreEditMode !== "off";
  // F-a/3: selectorOverrides counts as "pending" the same way drafts +
  // marked-for-deletion do — without this, clearing a saved region's
  // selector wouldn't enable the Save button. Padding/kind overrides
  // remain excluded to preserve prior behavior (their saves piggyback
  // on draft / delete edits).
  const hasPendingChanges =
    draftIgnoreAreas.length > 0 ||
    markedForDeletion.size > 0 ||
    selectorOverrides.size > 0 ||
    thresholdOverrides.size > 0;

  const handleSave = () => {
    const scope = ignoreEditMode === "off" ? "run" : ignoreEditMode;
    const payload = buildIgnoreAreasPayload(
      {
        savedRunIgnoreAreas,
        savedVariationIgnoreAreas,
        draftIgnoreAreas,
        markedForDeletion,
        paddingOverrides,
        kindOverrides,
        thresholdOverrides,
        selectorOverrides,
      },
      scope,
    );

    if (isTemporaryMode) {
      setTempIgnoreAreas.mutate({ runId, tempIgnoreAreas: payload });
    } else {
      setIgnoreAreas.mutate({ runId, scope, ignoreAreas: payload });
    }
  };

  return (
    <div className="flex items-center gap-4 flex-wrap p-2 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div
        className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-100/60 p-1 dark:border-zinc-800 dark:bg-zinc-900/50"
        role="tablist"
        aria-label="View mode"
      >
        {MODES.map((m) => {
          const active = mode === m.value;
          return (
            <button
              key={m.value}
              type="button"
              role="tab"
              data-mode={m.value}
              aria-selected={active}
              onClick={() => setMode(m.value)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-white"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white",
              )}
            >
              <m.Icon className="h-4 w-4" aria-hidden />
              {m.label}
            </button>
          );
        })}
      </div>

      <SensitivityControl
        runId={runId}
        runOverride={runDiffThresholdOverride}
        projectThreshold={project?.diffThreshold ?? null}
      />

      <div
        className="flex items-center gap-1"
        data-testid="zoom-controls"
        aria-label="Zoom"
      >
        <Button
          type="button"
          variant="secondary"
          className="px-2 py-1 text-xs h-7 w-7"
          data-testid="zoom-out-button"
          aria-label="Zoom out"
          title="Zoom out (−)"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          <ZoomOut className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="px-2 py-1 text-xs h-7 min-w-[3.5rem]"
          data-testid="zoom-reset-button"
          aria-label={`Reset zoom (currently ${Math.round(zoom * 100)}%)`}
          title="Fit to canvas (0)"
          onClick={() => resetZoom()}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="px-2 py-1 text-xs h-7 w-7"
          data-testid="zoom-in-button"
          aria-label="Zoom in"
          title="Zoom in (+)"
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          <ZoomIn className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="px-2 py-1 text-xs h-7 w-7"
          data-testid="fullscreen-toggle"
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? (
            <Minimize2 className="h-4 w-4" aria-hidden />
          ) : (
            <Maximize2 className="h-4 w-4" aria-hidden />
          )}
        </Button>
      </div>

      {stepper && stepper.count > 0 && (
        <div
          className="flex items-center gap-1"
          data-testid="diff-stepper"
          aria-label="Step through changes"
        >
          <Button
            type="button"
            variant="secondary"
            className="h-7 w-7 px-0 text-xs"
            data-testid="diff-prev"
            aria-label="Previous change"
            onClick={stepper.prev}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <span
            className="text-xs font-mono min-w-[4.5rem] text-center"
            data-testid="diff-counter"
          >
            Diff {stepper.index + 1} / {stepper.count}
          </span>
          <Button
            type="button"
            variant="secondary"
            className="h-7 w-7 px-0 text-xs"
            data-testid="diff-next"
            aria-label="Next change"
            onClick={stepper.next}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id="hide-displacement-toggle"
          checked={hideDisplacement}
          onCheckedChange={setHideDisplacement}
          data-testid="hide-displacement-toggle"
        />
        <Label
          htmlFor="hide-displacement-toggle"
          className="text-xs cursor-pointer"
        >
          Hide displacement
        </Label>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="highlight-toggle"
          checked={highlightActive}
          onCheckedChange={setHighlightActive}
          data-testid="highlight-toggle"
        />
        <Label htmlFor="highlight-toggle" className="cursor-pointer text-xs">
          Highlight diffs
        </Label>
      </div>

      {/* Single "Edit regions" button. Both scopes currently persist to the
          test variation (per-run storage is deferred — ADR-038/Phase 5), so a
          run-vs-variation dropdown would be a distinction without a difference.
          The "Temporary (this run only)" toggle below is the genuine one-off
          path (stored on the run, not the variation). */}
      {!editing ? (
        <Button
          type="button"
          variant="secondary"
          className="gap-1.5 px-2 py-1 text-xs"
          data-testid="edit-regions-toggle"
          onClick={() => setIgnoreEditMode("variation")}
        >
          <Pencil className="h-4 w-4" aria-hidden />
          Edit regions
        </Button>
      ) : (
        <Button
          type="button"
          variant="default"
          className="gap-1.5 px-2 py-1 text-xs"
          data-testid="edit-regions-toggle"
          onClick={() => setIgnoreEditMode("off")}
        >
          <Check className="h-4 w-4" aria-hidden />
          Done editing
        </Button>
      )}

      {editing && (
        <>
          <div
            className="flex items-center gap-1"
            data-testid="region-input-mode-toggle"
            aria-label="Region input mode"
          >
            <Button
              type="button"
              variant={regionInputMode === "drag" ? "default" : "secondary"}
              className="h-7 px-2 text-xs"
              data-testid="region-input-mode-drag"
              onClick={() => setRegionInputMode("drag")}
              title="Drag a rectangle on the canvas"
            >
              Drag
            </Button>
            <Button
              type="button"
              variant={regionInputMode === "pick" ? "default" : "secondary"}
              className="h-7 px-2 text-xs"
              data-testid="region-input-mode-pick"
              disabled={!hasElementMap}
              onClick={() => setRegionInputMode("pick")}
              title={
                hasElementMap
                  ? "Click an element to capture its bbox as a region"
                  : "Element picker requires an element-map sidecar (SDK PR #61). Older runs are drag-only."
              }
            >
              Pick element
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="temp-toggle"
              checked={isTemporaryMode}
              onCheckedChange={setTemporaryMode}
              data-testid="temp-ignore-toggle"
            />
            <Label htmlFor="temp-toggle" className="text-xs cursor-pointer">
              Temporary (this run only)
            </Label>
          </div>
          <Button
            type="button"
            variant="default"
            className="px-2 py-1 text-xs"
            data-testid="ignore-save-button"
            disabled={
              !hasPendingChanges ||
              setIgnoreAreas.isPending ||
              setTempIgnoreAreas.isPending
            }
            onClick={handleSave}
          >
            {setIgnoreAreas.isPending || setTempIgnoreAreas.isPending
              ? "Saving…"
              : "Save"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid="ignore-discard-button"
            disabled={
              !hasPendingChanges ||
              setIgnoreAreas.isPending ||
              setTempIgnoreAreas.isPending
            }
            onClick={discardIgnoreChanges}
          >
            Discard
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid="region-copy-button"
            disabled={!selectedIgnoreId}
            onClick={() => {
              const effective = selectEffectiveRegion(
                useViewerStore.getState(),
              );
              if (!effective) return;
              setClipboardRegion(projectId, effective);
              toast.success("Region copied");
            }}
          >
            Copy
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid="region-paste-button"
            disabled={!clipboard}
            onClick={() => {
              if (!clipboard) return;
              addDraftRegion({
                ...clipboard,
                id: crypto.randomUUID(),
                viewport: viewport || clipboard.viewport,
              });
            }}
          >
            Paste
          </Button>
        </>
      )}

      {editing && selectedIgnoreId && (
        <RegionSettingsPopover dynamicTextEnabled={dynamicTextEnabled} />
      )}

      {showSlider && (
        <div
          className="flex items-center gap-2 min-w-[200px]"
          data-testid="opacity-slider-wrap"
        >
          <span className="text-xs text-zinc-600 dark:text-zinc-400">
            {sliderLabel}
          </span>
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
