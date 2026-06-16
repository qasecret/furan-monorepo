"use client";

import { REGION_PATTERN_PRESETS } from "@furan/shared-types";

import { PatternEditor } from "./PatternEditor";
import {
  selectSelectedKindAndPattern,
  selectSelectedPaddingPx,
  selectSelectedSelector,
  selectSelectedThresholdOverride,
  useViewerStore,
} from "./useViewerStore";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  /** The current run id — passed through for potential future use. */
  runId: string;
  /** Project id — passed through for context. */
  projectId: string;
  /** Whether the project has dynamic-text mode enabled. Gates the kind selector. */
  dynamicTextEnabled: boolean;
}

/**
 * On-demand popover for per-region match-type controls (padding, kind,
 * tolerance, selector / pending-snap). Rendered only when editing AND a
 * region is selected — the parent (`ViewerToolbar`) gates this.
 *
 * The trigger button (`data-testid="region-settings-trigger"`) opens a
 * DropdownMenuContent panel containing the moved controls. All original
 * `data-testid` attributes are preserved verbatim.
 */
export function RegionSettingsPopover({ dynamicTextEnabled }: Props) {
  const selectedIgnoreId = useViewerStore((s) => s.selectedIgnoreId);
  const setPaddingForSelected = useViewerStore((s) => s.setPaddingForSelected);
  const selectedPaddingPx = useViewerStore(selectSelectedPaddingPx);
  const setKindForSelected = useViewerStore((s) => s.setKindForSelected);
  const setThresholdForSelected = useViewerStore(
    (s) => s.setThresholdForSelected,
  );
  const selectedThresholdOverride = useViewerStore(
    selectSelectedThresholdOverride,
  );
  // F-a/3: pending snap + selector indicator wiring.
  const pendingSnaps = useViewerStore((s) => s.pendingSnaps);
  const applyPendingSnap = useViewerStore((s) => s.applyPendingSnap);
  const dismissPendingSnap = useViewerStore((s) => s.dismissPendingSnap);
  const clearSelectorForSelected = useViewerStore(
    (s) => s.clearSelectorForSelected,
  );
  const selectedEffectiveSelector = useViewerStore(selectSelectedSelector);
  // Split into two primitive selectors so each subscription's equality is
  // reference-stable.
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

  if (!selectedIgnoreId) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          className="px-2 py-1 text-xs"
          data-testid="region-settings-trigger"
        >
          Region settings ▾
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-80 p-3 space-y-3 flex flex-col"
      >
        {/* Padding control */}
        <div className="flex items-center gap-2" data-testid="padding-control">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">
            Padding
          </span>
          <input
            type="range"
            min={0}
            max={32}
            step={1}
            value={selectedPaddingPx}
            onChange={(e) => setPaddingForSelected(Number(e.target.value))}
            className="w-32 accent-brand"
            data-testid="padding-slider"
            aria-label={`Padding for selected region, ${selectedPaddingPx} pixels`}
          />
          <span
            className="text-xs font-mono w-10 text-right text-zinc-700 dark:text-zinc-300"
            data-testid="padding-value"
          >
            {selectedPaddingPx}px
          </span>
        </div>

        {/* Strict tolerance control — only shown when kind === "strict" */}
        {selectedKindAndPattern.kind === "strict" && (
          <div
            className="flex items-center gap-2"
            data-testid="strict-tolerance-control"
          >
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              Tolerance
            </span>
            <input
              type="range"
              min={0}
              max={500}
              step={1}
              value={Math.round((selectedThresholdOverride ?? 0) * 10000)}
              onChange={(e) =>
                setThresholdForSelected(Number(e.target.value) / 10000)
              }
              className="w-32 accent-brand"
              data-testid="strict-tolerance-slider"
              aria-label={`Strict region tolerance, ${((selectedThresholdOverride ?? 0) * 100).toFixed(2)} percent`}
            />
            <span
              className="text-xs font-mono w-14 text-right text-zinc-700 dark:text-zinc-300"
              data-testid="strict-tolerance-value"
            >
              {((selectedThresholdOverride ?? 0) * 100).toFixed(2)}%
            </span>
          </div>
        )}

        {/* Pending-snap row — shown when no selector yet AND a pending snap exists */}
        {selectedEffectiveSelector === undefined
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

        {/* Selector row — shown when a selector is set on the selected region */}
        {selectedEffectiveSelector !== undefined && (
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

        {/* Kind control — only shown when dynamicTextEnabled */}
        {dynamicTextEnabled && (
          <div
            className="flex items-center gap-2"
            data-testid="region-kind-control"
          >
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              Kind
            </span>
            <div data-testid="region-kind-select">
              <Select
                value={selectedKindAndPattern.kind}
                onValueChange={(k) => {
                  // Each kind has its own setter call-shape — dynamic-text
                  // needs a pattern; the other 4 are plain mode flips. The
                  // store's `setKindForSelected` clears `pattern` whenever
                  // kind !== "dynamic-text", so we don't have to forward it.
                  if (k === "dynamic-text") {
                    setKindForSelected(
                      "dynamic-text",
                      selectedKindAndPattern.pattern ??
                        REGION_PATTERN_PRESETS.date,
                    );
                  } else if (
                    k === "ignore" ||
                    k === "strict" ||
                    k === "layout" ||
                    k === "content"
                  ) {
                    setKindForSelected(k);
                  }
                }}
              >
                <SelectTrigger className="w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ignore">Ignore</SelectItem>
                  <SelectItem value="strict">Strict</SelectItem>
                  <SelectItem value="layout">Layout</SelectItem>
                  <SelectItem value="content">Content</SelectItem>
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
            {/* Inline behavior hint per kind */}
            {selectedKindAndPattern.kind !== "ignore" &&
              selectedKindAndPattern.kind !== "dynamic-text" && (
                <span
                  className="text-[10px] text-zinc-500 max-w-[260px] dark:text-zinc-500"
                  data-testid="region-kind-hint"
                >
                  {selectedKindAndPattern.kind === "strict" &&
                    "Strict: pixel diff inside the bbox must stay within tolerance, else the run fails. Drag the slider to allow a percentage of mismatch."}
                  {selectedKindAndPattern.kind === "layout" &&
                    "Layout: pixel diff masked. Structural / positional DOM changes inside the bbox are flagged as major / layout."}
                  {selectedKindAndPattern.kind === "content" &&
                    "Content: pixel diff masked. Only text changes inside the bbox flag as major / text; attribute and styling changes are suppressed."}
                </span>
              )}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
