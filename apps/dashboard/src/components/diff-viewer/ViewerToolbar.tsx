"use client";

import { REGION_PATTERN_PRESETS } from "@furan/shared-types";
import { useState } from "react";
import { toast } from "sonner";

import { PatternEditor } from "./PatternEditor";
import { setClipboardRegion, useClipboardRegion } from "./region-clipboard";
import { SensitivityControl } from "./SensitivityControl";
import {
  selectEffectiveRegion,
  selectSelectedKindAndPattern,
  selectSelectedPaddingPx,
  selectSelectedSelector,
  useViewerStore,
  ZOOM_STEP,
  type ViewerMode,
} from "./useViewerStore";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";

const MODES: { value: ViewerMode; label: string }[] = [
  { value: "side-by-side", label: "Side-by-side" },
  { value: "overlay", label: "Overlay" },
  { value: "onion-skin", label: "Onion-skin" },
  { value: "diff-heatmap", label: "Diff heatmap" },
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
}

export function ViewerToolbar({
  runId,
  projectId = "",
  project,
  runDiffThresholdOverride = null,
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
  const savedRunIgnoreAreas = useViewerStore((s) => s.savedRunIgnoreAreas);
  const savedVariationIgnoreAreas = useViewerStore(
    (s) => s.savedVariationIgnoreAreas,
  );
  const draftIgnoreAreas = useViewerStore((s) => s.draftIgnoreAreas);
  const markedForDeletion = useViewerStore((s) => s.markedForDeletion);
  const discardIgnoreChanges = useViewerStore((s) => s.discardIgnoreChanges);
  const applySaveSuccess = useViewerStore((s) => s.applySaveSuccess);
  const selectedIgnoreId = useViewerStore((s) => s.selectedIgnoreId);
  const paddingOverrides = useViewerStore((s) => s.paddingOverrides);
  const setPaddingForSelected = useViewerStore((s) => s.setPaddingForSelected);
  const selectedPaddingPx = useViewerStore(selectSelectedPaddingPx);
  const kindOverrides = useViewerStore((s) => s.kindOverrides);
  const setKindForSelected = useViewerStore((s) => s.setKindForSelected);
  // F-a/3: pending snap + selector indicator wiring.
  const pendingSnaps = useViewerStore((s) => s.pendingSnaps);
  const selectorOverrides = useViewerStore((s) => s.selectorOverrides);
  const applyPendingSnap = useViewerStore((s) => s.applyPendingSnap);
  const dismissPendingSnap = useViewerStore((s) => s.dismissPendingSnap);
  const clearSelectorForSelected = useViewerStore(
    (s) => s.clearSelectorForSelected,
  );
  const selectedEffectiveSelector = useViewerStore(selectSelectedSelector);
  // Split into two primitive selectors so each subscription's equality is
  // reference-stable. (Returning a fresh object from a zustand selector
  // re-renders on every store change since the default equality is
  // `Object.is`.) Caller code that wants both still goes through the named
  // selector for unit testing.
  const selectedKind = useViewerStore(
    (s) => selectSelectedKindAndPattern(s).kind,
  );
  const selectedPattern = useViewerStore(
    (s) => selectSelectedKindAndPattern(s).pattern,
  );
  const selectedKindAndPattern = {
    kind: selectedKind,
    pattern: selectedPattern,
  };
  // Region clipboard wiring (Copy/Paste). `useClipboardRegion` subscribes
  // to same-tab + cross-tab clipboard events so the Paste button's
  // disabled state reflects the live clipboard.
  const clipboard = useClipboardRegion(projectId);
  const viewport = useViewerStore((s) => s.viewport);
  const addDraftRegion = useViewerStore((s) => s.addDraftRegion);

  const utils = trpc.useUtils();
  const setIgnoreAreas = trpc.runs.setIgnoreAreas.useMutation({
    onSuccess: (_data, vars) => {
      applySaveSuccess(vars.scope);
      void utils.runs.getById.invalidate({ runId });
    },
  });

  const [pendingScopeSwitch, setPendingScopeSwitch] = useState<
    "run" | "variation" | null
  >(null);

  const showSlider = mode === "overlay" || mode === "onion-skin";
  const sliderLabel =
    mode === "onion-skin" ? "Baseline ↔ Candidate" : "Candidate opacity";

  const editing = ignoreEditMode !== "off";
  // F-a/3: selectorOverrides counts as "pending" the same way drafts +
  // marked-for-deletion do — without this, clearing a saved region's
  // selector wouldn't enable the Save button. Padding/kind overrides
  // remain excluded to preserve prior behavior (their saves piggyback
  // on draft / delete edits).
  const hasPendingChanges =
    draftIgnoreAreas.length > 0 ||
    markedForDeletion.size > 0 ||
    selectorOverrides.size > 0;

  const requestEditMode = (next: "run" | "variation") => {
    if (editing && ignoreEditMode !== next && hasPendingChanges) {
      setPendingScopeSwitch(next);
      return;
    }
    setIgnoreEditMode(next);
  };

  const confirmScopeSwitch = () => {
    if (!pendingScopeSwitch) return;
    discardIgnoreChanges();
    setIgnoreEditMode(pendingScopeSwitch);
    setPendingScopeSwitch(null);
  };

  const cancelScopeSwitch = () => setPendingScopeSwitch(null);

  const handleSave = () => {
    const scope = ignoreEditMode === "off" ? "run" : ignoreEditMode;
    const activeSaved =
      scope === "variation" ? savedVariationIgnoreAreas : savedRunIgnoreAreas;
    const survivors = activeSaved
      .filter((r) => !markedForDeletion.has(r.id))
      .map((r) => {
        const kindOv = kindOverrides.get(r.id);
        const selectorOv = selectorOverrides.get(r.id);
        // F-a/3: `null` override = explicit clear (omit `selector` on
        // the wire). `undefined` = no override → preserve the saved
        // row's selector.
        const resolvedSelector =
          selectorOv === null ? undefined : (selectorOv ?? r.selector);
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          viewport: r.viewport,
          paddingPx: paddingOverrides.get(r.id) ?? r.paddingPx,
          kind: kindOv?.kind ?? r.kind,
          pattern: kindOv ? kindOv.pattern : r.pattern,
          selector: resolvedSelector,
        };
      });
    const drafts = draftIgnoreAreas.map((r) => ({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      viewport: r.viewport,
      paddingPx: r.paddingPx,
      kind: r.kind,
      pattern: r.pattern,
      selector: r.selector,
    }));
    setIgnoreAreas.mutate({
      runId,
      scope,
      ignoreAreas: [...survivors, ...drafts],
    });
  };

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
          −
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
          +
        </Button>
      </div>

      {/* When not editing: a single DropdownMenu with the toggle as its
          trigger so users can pick a scope to start editing. */}
      {!editing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              className="px-2 py-1 text-xs"
              data-testid="edit-regions-toggle"
            >
              Edit regions ▾
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              data-testid="edit-regions-run"
              onClick={() => requestEditMode("run")}
            >
              Edit for this run
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="edit-regions-variation"
              onClick={() => requestEditMode("variation")}
            >
              Edit for all runs of this test
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* When editing: a plain exit button (no dropdown) plus a separate
          DropdownMenu for switching scope. This avoids the ambiguity of a
          button that is simultaneously a dropdown trigger and an exit action —
          with userEvent / Radix pointer-event handling, both would fire and
          produce unpredictable results. */}
      {editing && (
        <>
          <Button
            type="button"
            variant="default"
            className="px-2 py-1 text-xs"
            data-testid="edit-regions-toggle"
            onClick={() => setIgnoreEditMode("off")}
          >
            {ignoreEditMode === "run"
              ? "Editing: this run"
              : "Editing: all runs"}{" "}
            ×
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                className="px-2 py-1 text-xs"
                data-testid="scope-switch-dropdown-trigger"
              >
                Switch scope ▾
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                data-testid="switch-scope-run"
                onClick={() => requestEditMode("run")}
                disabled={ignoreEditMode === "run"}
              >
                Edit for this run
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="switch-scope-variation"
                onClick={() => requestEditMode("variation")}
                disabled={ignoreEditMode === "variation"}
              >
                Edit for all runs of this test
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}

      {editing && (
        <>
          <Button
            type="button"
            variant="default"
            className="px-2 py-1 text-xs"
            data-testid="ignore-save-button"
            disabled={!hasPendingChanges || setIgnoreAreas.isPending}
            onClick={handleSave}
          >
            {setIgnoreAreas.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid="ignore-discard-button"
            disabled={!hasPendingChanges || setIgnoreAreas.isPending}
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

      {pendingScopeSwitch && (
        <div
          role="alertdialog"
          data-testid="scope-switch-confirm"
          className="flex items-center gap-2 text-xs"
        >
          <span>Discard unsaved changes and switch scope?</span>
          <Button
            type="button"
            variant="destructive"
            className="px-2 py-1 text-xs"
            data-testid="scope-switch-confirm-yes"
            onClick={confirmScopeSwitch}
          >
            Discard & switch
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="px-2 py-1 text-xs"
            data-testid="scope-switch-confirm-no"
            onClick={cancelScopeSwitch}
          >
            Cancel
          </Button>
        </div>
      )}

      {editing && selectedIgnoreId && (
        <div className="flex items-center gap-2" data-testid="padding-control">
          <span className="text-xs text-muted-foreground">Padding</span>
          <input
            type="range"
            min={0}
            max={32}
            step={1}
            value={selectedPaddingPx}
            onChange={(e) => setPaddingForSelected(Number(e.target.value))}
            className="w-32"
            data-testid="padding-slider"
            aria-label={`Padding for selected region, ${selectedPaddingPx} pixels`}
          />
          <span
            className="text-xs font-mono w-10 text-right"
            data-testid="padding-value"
          >
            {selectedPaddingPx}px
          </span>
        </div>
      )}

      {editing && selectedIgnoreId && selectedEffectiveSelector === undefined
        ? (() => {
            const ps = pendingSnaps.get(selectedIgnoreId);
            if (!ps) return null;
            return (
              <div
                className="flex items-center gap-2 text-xs"
                data-testid="pending-snap-row"
              >
                <span aria-hidden>🔗</span>
                <span>Anchor to</span>
                <code
                  className="truncate max-w-[200px] font-mono"
                  title={ps.selector}
                  data-testid="pending-snap-selector"
                >
                  {ps.selector}
                </code>
                <Button
                  type="button"
                  variant="default"
                  className="px-2 py-1 text-xs"
                  data-testid="pending-snap-apply"
                  onClick={() => applyPendingSnap(selectedIgnoreId)}
                >
                  Apply
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="px-2 py-1 text-xs"
                  data-testid="pending-snap-dismiss"
                  onClick={() => dismissPendingSnap(selectedIgnoreId)}
                >
                  Dismiss
                </Button>
              </div>
            );
          })()
        : null}

      {editing &&
        selectedIgnoreId &&
        selectedEffectiveSelector !== undefined && (
          <div
            className="flex items-center gap-2 text-xs"
            data-testid="selector-row"
          >
            <span aria-hidden>🔗</span>
            <code
              className="truncate max-w-[200px] font-mono"
              title={selectedEffectiveSelector}
              data-testid="selector-value"
            >
              {selectedEffectiveSelector}
            </code>
            <Button
              type="button"
              variant="secondary"
              className="px-1 py-0 text-xs h-6 w-6"
              data-testid="selector-clear"
              aria-label="Clear selector"
              onClick={clearSelectorForSelected}
            >
              ×
            </Button>
          </div>
        )}

      {editing && selectedIgnoreId && dynamicTextEnabled && (
        <div
          className="flex items-center gap-2"
          data-testid="region-kind-control"
        >
          <span className="text-xs text-muted-foreground">Kind</span>
          <div data-testid="region-kind-select">
            <Select
              value={selectedKindAndPattern.kind}
              onValueChange={(k) => {
                if (k === "dynamic-text") {
                  setKindForSelected(
                    "dynamic-text",
                    selectedKindAndPattern.pattern ??
                      REGION_PATTERN_PRESETS.date,
                  );
                } else {
                  setKindForSelected("ignore");
                }
              }}
            >
              <SelectTrigger className="w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ignore">Ignore</SelectItem>
                <SelectItem value="dynamic-text">Dynamic text</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {selectedKindAndPattern.kind === "dynamic-text" && (
            <PatternEditor
              value={selectedKindAndPattern.pattern ?? ""}
              onChange={(p) => setKindForSelected("dynamic-text", p)}
            />
          )}
        </div>
      )}

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
