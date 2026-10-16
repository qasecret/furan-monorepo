"use client";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeftRight,
  Layers,
  Maximize2,
  Minimize2,
  Pencil,
  Repeat,
  SlidersHorizontal,
  SplitSquareHorizontal,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";

import {
  VIEWER_MODE_COMMAND,
  VIEWER_MODE_LABEL,
  VIEWER_MODES,
  type ViewerMode,
} from "./comparison-modes";
import { FlickerControls } from "./FlickerControls";
import { buildIgnoreAreasPayload } from "./ignore-area-payload";
import { setClipboardRegion, useClipboardRegion } from "./region-clipboard";
import { RegionSettingsPopover } from "./RegionSettingsPopover";
import { SensitivityControl } from "./SensitivityControl";
import type { DiffStepper } from "./useDiffStepper";
import { selectEffectiveRegion, useViewerStore } from "./useViewerStore";
import { useViewState } from "./view-state";
import { ZOOM_STEP } from "./viewer-geometry";
import {
  useAvailableModes,
  useEffectiveMode,
  useSetViewerMode,
} from "./viewer-mode";
import { useViewerPrefs } from "./viewer-prefs";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { useCommandKeys, type CommandKeys } from "@/lib/commands/registry";
import { trpc } from "@/lib/trpc";

/** Each mode's icon in the radio group. */
const MODE_ICON: Record<ViewerMode, typeof Layers> = {
  "side-by-side": SplitSquareHorizontal,
  swipe: ChevronsLeftRight,
  flicker: Repeat,
  overlay: SlidersHorizontal,
  diff: Layers,
};

/**
 * A control's title from its command's keys (`useCommandKeys`): "Zoom out
 * (-)". An icon-only control keeps its name as the tooltip when there is no
 * key to name (`keep`); a control with its name on screen then has none.
 */
function hintTitle(
  label: string,
  { titleSuffix }: CommandKeys,
  keep = false,
): string | undefined {
  if (titleSuffix) return `${label}${titleSuffix}`;
  return keep ? label : undefined;
}

interface Props {
  /** The current run id — needed for the setIgnoreAreas mutation. */
  runId: string;
  /**
   * The selected step's checkpoint id. A saved region goes to THIS step's
   * variation (the diff-worker masks each step with its own variation's
   * regions), so Save stays disabled until the step is known: without it the
   * server would write the run's first step.
   */
  checkpointId?: string | undefined;
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
  /**
   * The step has a baseline. Without one only side by side is available
   * (R2): the other modes are shown disabled, and a chosen one (stored, or
   * the URL's) shows as side by side (it is kept).
   */
  hasBaseline?: boolean;
}

/** A disabled mode's tooltip (spec §8). */
const NEEDS_A_BASELINE = "Needs a baseline";

/** Where each arrow key moves in the group: the native radio pattern. */
const ARROW_STEP: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * The comparison mode control (spec §4.1): a radio group named "Comparison
 * mode", one radio per mode, the mode on screen checked. It follows the
 * native radio pattern: one tab stop (the checked radio), ←/↑ and →/↓ move
 * the check, and the mode with it, to the previous or next radio, round from
 * the ends, and Home / End to the first or last. A mode the step can't show
 * (no baseline) stays focusable and named, but inert, says why in its
 * tooltip, and the arrows pass it by. The keys are the group's: an arrow
 * here never moves to another step, and a held one moves once.
 */
function ComparisonModes({ hasBaseline }: { hasBaseline: boolean }) {
  // The viewer's one mode, and its way to change it: stored, and in the URL.
  const mode = useEffectiveMode(hasBaseline);
  const setMode = useSetViewerMode();
  const available = useAvailableModes(hasBaseline);
  const radios = useRef<Partial<Record<ViewerMode, HTMLButtonElement>>>({});

  /** Checks `next`, shows it, and puts the focus on its radio. */
  const select = (next: ViewerMode) => {
    if (next !== mode) setMode(next);
    radios.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const choosable = VIEWER_MODES.filter((m) => available[m]);
    if (choosable.length === 0) return;
    const from = e.currentTarget.dataset.mode as ViewerMode;
    let next: ViewerMode | undefined;
    if (e.key === "Home") next = choosable[0];
    else if (e.key === "End") next = choosable.at(-1);
    else if (e.key in ARROW_STEP) {
      const step = ARROW_STEP[e.key]!;
      const n = VIEWER_MODES.length;
      let at = VIEWER_MODES.indexOf(from);
      for (let i = 0; i < n; i += 1) {
        at = (at + step + n) % n;
        if (available[VIEWER_MODES[at]!]) break;
      }
      next = VIEWER_MODES[at];
    } else return;
    // The group's key, not the page's (step navigation) nor the browser's.
    e.preventDefault();
    // A held arrow moves once: each mode is a new URL, and a round trip.
    if (e.repeat) return;
    if (next) select(next);
  };

  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-edge bg-sunken p-1"
      role="radiogroup"
      aria-label="Comparison mode"
    >
      {VIEWER_MODES.map((m) => (
        <ModeRadio
          key={m}
          mode={m}
          checked={mode === m}
          disabled={!available[m]}
          onSelect={() => setMode(m)}
          onKeyDown={onKeyDown}
          radioRef={(el) => {
            if (el) radios.current[m] = el;
            else delete radios.current[m];
          }}
        />
      ))}
    </div>
  );
}

/** One radio of the group, with its command's key hint (`useCommandKeys`). */
function ModeRadio({
  mode,
  checked,
  disabled,
  onSelect,
  onKeyDown,
  radioRef,
}: {
  mode: ViewerMode;
  checked: boolean;
  disabled: boolean;
  onSelect(): void;
  onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void;
  radioRef(el: HTMLButtonElement | null): void;
}) {
  const keys = useCommandKeys(VIEWER_MODE_COMMAND[mode]);
  const label = VIEWER_MODE_LABEL[mode];
  const Icon = MODE_ICON[mode];
  return (
    <button
      ref={radioRef}
      type="button"
      role="radio"
      data-mode={mode}
      aria-checked={checked}
      // One tab stop: the checked radio (roving tabindex).
      tabIndex={checked ? 0 : -1}
      // Focusable and named, but inert, so its tooltip says why.
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={disabled ? undefined : keys.ariaKeyShortcuts}
      title={disabled ? NEEDS_A_BASELINE : hintTitle(label, keys)}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={onKeyDown}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-ring",
        checked
          ? "bg-raised text-fg shadow-raised"
          : disabled
            ? "cursor-not-allowed text-fg-muted opacity-50"
            : "text-fg-muted hover:text-fg",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

export function ViewerToolbar({
  runId,
  checkpointId,
  projectId = "",
  project,
  runDiffThresholdOverride = null,
  hasElementMap = false,
  stepper,
  hasBaseline = true,
}: Props) {
  const dynamicTextEnabled = project?.dynamicTextEnabled ?? false;
  // The viewer's one mode: its own controls show with it.
  const mode = useEffectiveMode(hasBaseline);
  const opacity = useViewerPrefs((s) => s.prefs.opacity);
  const hideDisplacement = useViewerPrefs((s) => s.prefs.hideDisplacement);
  const highlight = useViewerPrefs((s) => s.prefs.highlight);
  const setPref = useViewerPrefs((s) => s.set);
  const zoom = useViewState((s) => s.zoom);
  const zoomBy = useViewState((s) => s.zoomBy);
  const resetZoom = useViewState((s) => s.resetZoom);

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
  const isTemporaryMode = useViewerStore((s) => s.isTemporaryMode);
  const setTemporaryMode = useViewerStore((s) => s.setTemporaryMode);
  const selectedIgnoreId = useViewerStore((s) => s.selectedIgnoreId);
  const paddingOverrides = useViewerStore((s) => s.paddingOverrides);
  const kindOverrides = useViewerStore((s) => s.kindOverrides);
  const thresholdOverrides = useViewerStore((s) => s.thresholdOverrides);
  const selectorOverrides = useViewerStore((s) => s.selectorOverrides);
  const geometryOverrides = useViewerStore((s) => s.geometryOverrides);
  // Region clipboard wiring (Copy/Paste). `useClipboardRegion` subscribes
  // to same-tab + cross-tab clipboard events so the Paste button's
  // disabled state reflects the live clipboard.
  const clipboard = useClipboardRegion(projectId);
  const viewport = useViewerStore((s) => s.viewport);
  const addDraftRegion = useViewerStore((s) => s.addDraftRegion);

  // Every key hint here comes from the viewer's commands (spec §5.4): one
  // source, dropped with the single-key switch, absent with no command.
  const zoomOutKeys = useCommandKeys("viewer.zoomOut");
  const fitKeys = useCommandKeys("viewer.fit");
  const zoomInKeys = useCommandKeys("viewer.zoomIn");
  const prevChangeKeys = useCommandKeys("viewer.prevRegion");
  const nextChangeKeys = useCommandKeys("viewer.nextRegion");
  const highlightKeys = useCommandKeys("viewer.highlight");
  const editorKeys = useCommandKeys("editor.toggle");

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
    thresholdOverrides.size > 0 ||
    geometryOverrides.size > 0;
  // A temporary region lives on the run; a saved one needs the step.
  const saveTargetMissing = !isTemporaryMode && !checkpointId;

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
        geometryOverrides,
      },
      scope,
    );

    if (isTemporaryMode) {
      setTempIgnoreAreas.mutate({ runId, tempIgnoreAreas: payload });
    } else if (checkpointId) {
      setIgnoreAreas.mutate({
        runId,
        scope,
        checkpointId,
        ignoreAreas: payload,
      });
    }
  };

  return (
    <div className="flex items-center gap-4 flex-wrap p-2 border-b border-edge bg-canvas">
      <ComparisonModes hasBaseline={hasBaseline} />

      {mode === "flicker" && <FlickerControls />}

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
          aria-keyshortcuts={zoomOutKeys.ariaKeyShortcuts}
          title={hintTitle("Zoom out", zoomOutKeys, true)}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          <ZoomOut className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="px-2 py-1 text-xs tabular-nums h-7 min-w-[3.5rem]"
          data-testid="zoom-reset-button"
          aria-label={`Reset zoom (currently ${Math.round(zoom * 100)}%)`}
          aria-keyshortcuts={fitKeys.ariaKeyShortcuts}
          title={hintTitle("Fit to canvas", fitKeys, true)}
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
          aria-keyshortcuts={zoomInKeys.ariaKeyShortcuts}
          title={hintTitle("Zoom in", zoomInKeys, true)}
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
            aria-keyshortcuts={prevChangeKeys.ariaKeyShortcuts}
            title={hintTitle("Previous change", prevChangeKeys, true)}
            onClick={stepper.prev}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <span
            className="text-xs font-mono tabular-nums min-w-[4.5rem] text-center"
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
            aria-keyshortcuts={nextChangeKeys.ariaKeyShortcuts}
            title={hintTitle("Next change", nextChangeKeys, true)}
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
          onCheckedChange={(v) => setPref("hideDisplacement", v)}
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
          checked={highlight}
          onCheckedChange={(v) => setPref("highlight", v)}
          aria-keyshortcuts={highlightKeys.ariaKeyShortcuts}
          title={hintTitle("Highlight diffs", highlightKeys)}
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
          aria-keyshortcuts={editorKeys.ariaKeyShortcuts}
          title={hintTitle("Edit regions", editorKeys)}
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
          aria-keyshortcuts={editorKeys.ariaKeyShortcuts}
          title={hintTitle("Done editing", editorKeys)}
          onClick={() => setIgnoreEditMode("off")}
        >
          <Check className="h-4 w-4" aria-hidden />
          Done editing
        </Button>
      )}

      {editing && (
        <>
          {/* Region input mode (Drag vs. Pick element) only matters when the
              run has an element-map sidecar. Without one, "Drag" is the only
              possibility (the canvas defaults to it), so we hide the toggle
              entirely rather than show a permanently-disabled "Pick element"
              button. Real SDK-captured runs carry the element map and get the
              full toggle. */}
          {hasElementMap && (
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
                onClick={() => setRegionInputMode("pick")}
                title="Click an element to capture its bbox as a region"
              >
                Pick element
              </Button>
            </div>
          )}
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
              saveTargetMissing ||
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
          <span className="text-xs text-fg-secondary">{sliderLabel}</span>
          {/* Each value shows live while the thumb moves; only the one it
              is released on is stored. */}
          <Slider
            value={[Math.round(opacity * 100)]}
            onValueChange={([v]) =>
              setPref("opacity", (v ?? 0) / 100, { persist: false })
            }
            onValueCommit={([v]) => setPref("opacity", (v ?? 0) / 100)}
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
