import { create } from "zustand";

import type { ElementBbox } from "./useElementMap";

export type ViewerMode = "side-by-side" | "overlay" | "difference";

/**
 * Region match modes, Applitools-aligned. See
 * `furan-design/specs/2026-05-23-region-modes-design.md` for the engine
 * routing per mode + the v1-vs-deferred breakdown.
 */
export type RegionKind =
  | "ignore"
  | "dynamic-text"
  | "strict"
  | "layout"
  | "content";

/**
 * ADR-038 region kind tab — the kind filter shown above RegionListPanel.
 * Distinct from `RegionKind` (ignore-region type) — this maps to the
 * ADR-038 diff-region classification (Ignore / Layout / Floating / Content /
 * A11y) and drives which tab is active in `RegionKindTabs`.
 */
export type RegionKindTab =
  | "ignore"
  | "layout"
  | "floating"
  | "content"
  | "accessibility";

/** ADR-031: a single ignore region in image-pixel space. */
export interface IgnoreArea {
  /** Client-side id assigned at hydration; not persisted server-side. */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  viewport: string;
  /** Inflated by N pixels on all sides before the diff engine masks. 0-32. */
  paddingPx: number;
  /**
   * - `ignore`: mask always (default).
   * - `dynamic-text`: mask only when OCR matches `pattern`.
   * - `strict`: pixel diff inside the bbox must stay within
   *   `thresholdOverride` (default 0). Any breach fails the run AND
   *   emits a `severity: "breaking"` region — the contract form of the
   *   match modes.
   * - `layout`: pixel diff inside the bbox is masked; structural / DOM
   *   changes intersecting the bbox are re-tagged
   *   `severity: "major", category: "layout"`.
   * - `content`: pixel diff inside the bbox is masked; only text-node
   *   changes intersecting the bbox survive (tagged `major` / `text`).
   *   Attribute / structural changes inside the bbox are suppressed.
   */
  kind: RegionKind;
  /** Required when kind === "dynamic-text"; regex source string (no flags). */
  pattern?: string;
  /**
   * Per-region diff threshold override, 0..1 fraction (same units as
   * `projects.diffThreshold`). Only valid for `kind: "strict"` — the
   * server-side zod refines against this. Honored by the diff worker
   * (`apps/diff-worker/src/strict-tolerance.ts`); a fraction-over-
   * tolerance fails the run.
   */
  thresholdOverride?: number;
  /**
   * Optional CSS-path anchor (F-a subproject 3). When present, the diff
   * engine resolves the region's mask geometry against the candidate's
   * element map at mask time (PR #63); the stored x/y/w/h is the
   * fallback when the selector misses. Captured by the SDK (PR #61);
   * the editor either pushes it through or clears it — there's no
   * hand-edit UI.
   */
  selector?: string;
}

/**
 * A draft region created by the user but not yet saved. Identical shape to
 * `IgnoreArea` (the wire format requires `viewport`) plus an id assigned
 * at creation time so React can key the layer's child Graphics objects.
 */
export type DraftIgnoreArea = IgnoreArea;

/**
 * Server-shaped region for hydration. `kind`/`pattern` are optional here
 * because legacy rows (and rows persisted before the dynamic-text feature
 * shipped) don't carry these fields — `hydrateSavedIgnoreAreas` defaults
 * `kind` to `"ignore"` when missing.
 */
export type HydrateIgnoreArea = Omit<IgnoreArea, "id" | "kind"> & {
  kind?: IgnoreArea["kind"];
};

export type IgnoreEditMode = "off" | "run" | "variation";

/**
 * Region creation input mode (only meaningful when `ignoreEditMode !== "off"`):
 * - `drag` (default): drag a rectangle on the canvas; the rectangle becomes
 *   the draft region's bbox.
 * - `pick`: single-click on an element; the element's captured bbox + selector
 *   become the draft. Requires the SDK to have captured an element map for the
 *   candidate screenshot.
 */
export type RegionInputMode = "drag" | "pick";

/**
 * Min/max zoom factor relative to fit. 1.0 = fit-to-canvas (the default
 * computed by `world-fit.ts`). 4.0 = 4x of fit, which on a typical viewport
 * lets you read sub-pixel anti-aliasing. 0.25 prevents users from
 * accidentally shrinking past the readable threshold via repeated wheel-out.
 */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.25;

interface State {
  mode: ViewerMode;
  opacity: number;
  selectedRegionId: string | null;
  viewport: string;
  commentPanelOpen: boolean;
  /**
   * Zoom relative to fit-to-canvas. 1 = fit. Applied uniformly to both
   * panes in side-by-side so reviewers compare like for like.
   */
  zoom: number;
  /**
   * Pan offset in canvas-CSS pixels, applied on top of the fit-centered
   * position. (0,0) = centered like fit. Reset whenever zoom returns to 1
   * via `resetZoom` so a "reset" feels like a fresh fit.
   */
  panX: number;
  panY: number;
  /** Set by the diff stepper to request the canvas frame a region; the
   * canvas applies it via computeFocusView then clears it back to null. */
  focusBbox: { x: number; y: number; width: number; height: number } | null;
  hideDisplacement: boolean;
  highlightActive: boolean;
  setFocusBbox: (b: State["focusBbox"]) => void;
  setHideDisplacement: (v: boolean) => void;
  setHighlightActive: (v: boolean) => void;
  /** Atomic zoom+pan set (stepper focus). */
  setView: (v: { zoom: number; panX: number; panY: number }) => void;

  // ADR-031 ignore-region editor state.
  ignoreEditMode: IgnoreEditMode;
  /**
   * Region input mode — defaults to drag-rectangle. Reset to "drag" whenever
   * `ignoreEditMode` flips off so re-entering the editor doesn't strand the
   * user in pick mode without the affordance being visible.
   */
  regionInputMode: RegionInputMode;
  savedRunIgnoreAreas: IgnoreArea[];
  savedVariationIgnoreAreas: IgnoreArea[];
  draftIgnoreAreas: DraftIgnoreArea[];
  markedForDeletion: Set<string>;
  /**
   * Padding adjustments for SAVED regions (drafts mutate in place). Keyed
   * by region id. Mirrors `markedForDeletion`'s role for the "saved row
   * was edited this session" case. Cleared on discardIgnoreChanges and
   * applySaveSuccess.
   */
  paddingOverrides: Map<string, number>;
  /**
   * Kind/pattern adjustments for SAVED regions (drafts mutate in place).
   * Keyed by region id. Same lifecycle as `paddingOverrides`.
   */
  kindOverrides: Map<string, { kind: IgnoreArea["kind"]; pattern?: string }>;
  /**
   * Per-region tolerance overrides for saved STRICT regions (drafts
   * mutate in place). Keyed by region id. A `undefined` value is an
   * explicit clear (the save payload omits the field). Cleared on
   * discardIgnoreChanges and applySaveSuccess.
   */
  thresholdOverrides: Map<string, number | undefined>;
  /**
   * F-a/3: per-draft snap suggestions surfaced after the user finishes a
   * drag-draw. Keyed by draft.id. The store is the source of truth for
   * "does this draft have a pending Anchor-to-`<selector>` proposal";
   * the canvas/toolbar reads from here, the DiffViewer effect writes here.
   * Cleared by the same lifecycle hooks as `paddingOverrides`.
   */
  pendingSnaps: Map<string, { selector: string; bbox: ElementBbox }>;
  /**
   * F-a/3: per-saved-region selector overrides (`null` = "user cleared the
   * inherited selector"). Mirrors the `kindOverrides` pattern — drafts
   * mutate in place; saved regions push an entry here, reconciled by
   * `applySaveSuccess` and the toolbar's save payload builder.
   */
  selectorOverrides: Map<string, string | null>;
  selectedIgnoreId: string | null;
  isTemporaryMode: boolean;
  setTemporaryMode: (v: boolean) => void;

  setMode: (mode: ViewerMode) => void;
  setOpacity: (opacity: number) => void;
  setSelected: (id: string | null) => void;
  setViewport: (viewport: string) => void;
  setCommentPanelOpen: (open: boolean) => void;
  /** Multiplicative zoom (e.g. ZOOM_STEP for +1 step). Clamped to [MIN,MAX]. */
  zoomBy: (factor: number) => void;
  /**
   * Zoom centered on a canvas-CSS-space anchor point so the world point under
   * the anchor stays put. Used by the mouse-wheel + double-click handlers.
   */
  zoomAt: (
    factor: number,
    anchor: { x: number; y: number },
    canvasSize: { width: number; height: number },
  ) => void;
  /** Direct zoom set; same clamping as zoomBy. */
  setZoom: (zoom: number) => void;
  /** Reset zoom AND pan — single call so the toolbar/Hotkey can use one action. */
  resetZoom: () => void;
  /** Increment current pan by (dx,dy) in canvas-CSS pixels. */
  panBy: (dx: number, dy: number) => void;

  /** ADR-038: which region-kind tab is active above RegionListPanel. */
  selectedRegionKind: RegionKindTab;
  setSelectedRegionKind: (k: RegionKindTab) => void;
  /** ADR-038: which checkpoint is currently open in the diff viewer. */
  selectedCheckpointId: string | null;
  setSelectedCheckpointId: (id: string | null) => void;

  setIgnoreEditMode: (mode: IgnoreEditMode) => void;
  setRegionInputMode: (mode: RegionInputMode) => void;
  hydrateSavedIgnoreAreas: (
    run: Array<HydrateIgnoreArea>,
    variation: Array<HydrateIgnoreArea>,
  ) => void;
  addDraftRegion: (region: DraftIgnoreArea) => void;
  setSelectedIgnoreId: (id: string | null) => void;
  /** Removes a draft region by id, OR marks a saved region for deletion. */
  deleteSelected: () => void;
  /**
   * Padding adjustment for the currently-selected region. Mutates draft
   * regions in place; for saved regions, sets an entry in paddingOverrides.
   * No-op when nothing is selected.
   */
  setPaddingForSelected: (paddingPx: number) => void;
  /**
   * Kind/pattern setter for the currently-selected region. Mutates drafts
   * in place; for saved regions, sets an entry in kindOverrides. When kind
   * is "ignore" the pattern is cleared.
   */
  setKindForSelected: (kind: IgnoreArea["kind"], pattern?: string) => void;
  /**
   * Tolerance setter for the currently-selected STRICT region. Mutates
   * drafts in place; for saved regions, sets an entry in
   * thresholdOverrides. Pass `undefined` to clear.
   */
  setThresholdForSelected: (threshold: number | undefined) => void;
  /**
   * F-a/3: record a snap suggestion for a freshly-drawn draft. Idempotent
   * on the same draft id — re-proposing keeps the first suggestion so
   * effect re-runs don't bounce the value.
   */
  proposePendingSnap: (
    draftId: string,
    snap: { selector: string; bbox: ElementBbox },
  ) => void;
  /**
   * F-a/3: accept a pending snap → writes `selector` onto the draft and
   * removes the pending entry. No-op when the draft has no pending snap.
   */
  applyPendingSnap: (draftId: string) => void;
  /**
   * F-a/3: dismiss a pending snap → removes the pending entry without
   * touching the draft. No-op when nothing is pending for the draft.
   */
  dismissPendingSnap: (draftId: string) => void;
  /**
   * F-a/3: clear the selector on the currently-selected region. For a
   * draft, mutates in place. For a saved region, records a `null`
   * override that the save payload builder converts to "explicit clear."
   * Matches the `setPaddingForSelected` / `setKindForSelected` shape.
   */
  clearSelectorForSelected: () => void;
  /** Wipes drafts, markedForDeletion, paddingOverrides, and kindOverrides. */
  discardIgnoreChanges: () => void;
  /**
   * Called after a successful save mutation: clears markedForDeletion +
   * paddingOverrides, promotes drafts to the matching saved slice (based
   * on scope), and clears the draft slice.
   */
  applySaveSuccess: (scope: "run" | "variation") => void;
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

export const useViewerStore = create<State>((set) => ({
  mode: "side-by-side",
  opacity: 0.5,
  selectedRegionId: null,
  viewport: "",
  commentPanelOpen: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  focusBbox: null,
  hideDisplacement: false,
  highlightActive: false,

  selectedRegionKind: "ignore",
  selectedCheckpointId: null,

  ignoreEditMode: "off",
  regionInputMode: "drag",
  savedRunIgnoreAreas: [],
  savedVariationIgnoreAreas: [],
  draftIgnoreAreas: [],
  markedForDeletion: new Set(),
  paddingOverrides: new Map(),
  kindOverrides: new Map(),
  thresholdOverrides: new Map(),
  pendingSnaps: new Map(),
  selectorOverrides: new Map(),
  selectedIgnoreId: null,
  isTemporaryMode: false,
  setTemporaryMode: (isTemporaryMode) => set({ isTemporaryMode }),

  setMode: (mode) =>
    // Mode change resets zoom — different modes (side-by-side vs overlay)
    // have different canvas sizes, and persisting a zoom across the
    // transition would feel arbitrary.
    set({ mode, zoom: 1, panX: 0, panY: 0 }),
  setOpacity: (opacity) => set({ opacity }),
  setSelected: (selectedRegionId) => set({ selectedRegionId }),
  setViewport: (viewport) => set({ viewport }),
  setCommentPanelOpen: (commentPanelOpen) => set({ commentPanelOpen }),
  zoomBy: (factor) => set((s) => ({ zoom: clampZoom(s.zoom * factor) })),
  zoomAt: (factor, anchor, canvasSize) =>
    set((s) => {
      const nextZoom = clampZoom(s.zoom * factor);
      if (nextZoom === s.zoom) return {};
      // We want the world-space point currently under `anchor` to stay
      // under `anchor` after zoom. The world transform is:
      //   screen = center + pan + worldLocal * fitScale * zoom
      // (where center = canvas/2 - imgFitSize/2; pan is our state)
      // The portion that scales with zoom is `worldLocal * fitScale * zoom`.
      // Treating that whole term as `delta`, we get
      //   anchor = center + pan + delta
      //   anchor = center + pan' + delta * (nextZoom/oldZoom)
      // The center cancels, so
      //   pan' = anchor - center - (anchor - center - pan) * ratio
      // Rather than tracking fitScale here (the canvas owns that),
      // approximate: scale pan around the anchor — visually identical
      // when the image is centered fit. The canvas applies the math
      // exactly via fitWorldToCanvas's center.
      const ratio = nextZoom / s.zoom;
      const cx = canvasSize.width / 2;
      const cy = canvasSize.height / 2;
      const offsetX = anchor.x - cx - s.panX;
      const offsetY = anchor.y - cy - s.panY;
      const panX = s.panX - offsetX * (ratio - 1);
      const panY = s.panY - offsetY * (ratio - 1);
      return { zoom: nextZoom, panX, panY };
    }),
  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
  resetZoom: () => set({ zoom: 1, panX: 0, panY: 0 }),
  panBy: (dx, dy) => set((s) => ({ panX: s.panX + dx, panY: s.panY + dy })),
  setFocusBbox: (focusBbox) => set({ focusBbox }),
  setHideDisplacement: (hideDisplacement) => set({ hideDisplacement }),
  setHighlightActive: (highlightActive) => set({ highlightActive }),
  setView: ({ zoom, panX, panY }) => set({ zoom: clampZoom(zoom), panX, panY }),

  setSelectedRegionKind: (selectedRegionKind) => set({ selectedRegionKind }),
  setSelectedCheckpointId: (selectedCheckpointId) =>
    set({ selectedCheckpointId }),

  setIgnoreEditMode: (ignoreEditMode) =>
    set((s) => ({
      ignoreEditMode,
      // Reset the input mode whenever the editor exits so re-entering
      // starts on the (more familiar) drag affordance.
      regionInputMode: ignoreEditMode === "off" ? "drag" : s.regionInputMode,
    })),
  setRegionInputMode: (regionInputMode) => set({ regionInputMode }),
  hydrateSavedIgnoreAreas: (run, variation) =>
    set((s) => {
      const hasUnsaved =
        s.draftIgnoreAreas.length > 0 ||
        s.markedForDeletion.size > 0 ||
        s.paddingOverrides.size > 0 ||
        s.kindOverrides.size > 0 ||
        s.thresholdOverrides.size > 0 ||
        s.selectorOverrides.size > 0;
      const hydrate = (r: HydrateIgnoreArea): IgnoreArea => ({
        ...r,
        id: crypto.randomUUID(),
        paddingPx: r.paddingPx ?? 0,
        kind: r.kind ?? "ignore",
        pattern: r.pattern,
        selector: r.selector,
      });
      const saved = {
        savedRunIgnoreAreas: run.map(hydrate),
        savedVariationIgnoreAreas: variation.map(hydrate),
      };
      if (hasUnsaved) {
        // Spurious refetch (window focus, SSE invalidation, mutation
        // success on a *sibling* mutation) must not destroy in-progress
        // user work. Update only the server-derived slices.
        return saved;
      }
      return {
        ...saved,
        draftIgnoreAreas: [],
        markedForDeletion: new Set(),
        paddingOverrides: new Map(),
        kindOverrides: new Map(),
        thresholdOverrides: new Map(),
        pendingSnaps: new Map(),
        selectorOverrides: new Map(),
        selectedIgnoreId: null,
      };
    }),
  addDraftRegion: (region) =>
    set((s) => ({ draftIgnoreAreas: [...s.draftIgnoreAreas, region] })),
  setSelectedIgnoreId: (selectedIgnoreId) => set({ selectedIgnoreId }),
  deleteSelected: () =>
    set((s) => {
      if (!s.selectedIgnoreId) return {};
      const draftIdx = s.draftIgnoreAreas.findIndex(
        (r) => r.id === s.selectedIgnoreId,
      );
      if (draftIdx !== -1) {
        const next = [...s.draftIgnoreAreas];
        next.splice(draftIdx, 1);
        return { draftIgnoreAreas: next, selectedIgnoreId: null };
      }
      // If the id is not a draft, assume it's a saved region and mark
      // it for deletion. selectedIgnoreId is always set from active-
      // scope regions visible in the UI, so a phantom id can't be
      // introduced via the click path; this branch is the catch-all
      // for the saved-region case.
      const next = new Set(s.markedForDeletion);
      next.add(s.selectedIgnoreId);
      return { markedForDeletion: next, selectedIgnoreId: null };
    }),
  setPaddingForSelected: (paddingPx) =>
    set((s) => {
      if (!s.selectedIgnoreId) return {};
      const draftIdx = s.draftIgnoreAreas.findIndex(
        (r) => r.id === s.selectedIgnoreId,
      );
      if (draftIdx !== -1) {
        const next = [...s.draftIgnoreAreas];
        const existing = next[draftIdx]!;
        next[draftIdx] = { ...existing, paddingPx };
        return { draftIgnoreAreas: next };
      }
      const overrides = new Map(s.paddingOverrides);
      overrides.set(s.selectedIgnoreId, paddingPx);
      return { paddingOverrides: overrides };
    }),
  setKindForSelected: (kind, pattern) =>
    set((s) => {
      if (!s.selectedIgnoreId) return {};
      const draftIdx = s.draftIgnoreAreas.findIndex(
        (r) => r.id === s.selectedIgnoreId,
      );
      if (draftIdx !== -1) {
        const next = [...s.draftIgnoreAreas];
        const existing = next[draftIdx]!;
        next[draftIdx] = {
          ...existing,
          kind,
          pattern: kind === "dynamic-text" ? pattern : undefined,
        };
        return { draftIgnoreAreas: next };
      }
      const overrides = new Map(s.kindOverrides);
      overrides.set(s.selectedIgnoreId, {
        kind,
        pattern: kind === "dynamic-text" ? pattern : undefined,
      });
      return { kindOverrides: overrides };
    }),
  setThresholdForSelected: (threshold) =>
    set((s) => {
      if (!s.selectedIgnoreId) return {};
      const draftIdx = s.draftIgnoreAreas.findIndex(
        (r) => r.id === s.selectedIgnoreId,
      );
      if (draftIdx !== -1) {
        const next = [...s.draftIgnoreAreas];
        const existing = next[draftIdx]!;
        next[draftIdx] = { ...existing, thresholdOverride: threshold };
        return { draftIgnoreAreas: next };
      }
      const overrides = new Map(s.thresholdOverrides);
      overrides.set(s.selectedIgnoreId, threshold);
      return { thresholdOverrides: overrides };
    }),
  proposePendingSnap: (draftId, snap) =>
    set((s) => {
      // Idempotent: an effect that re-fires on dependency change must
      // not overwrite a snap the user is mid-decision on.
      if (s.pendingSnaps.has(draftId)) return {};
      const next = new Map(s.pendingSnaps);
      next.set(draftId, snap);
      return { pendingSnaps: next };
    }),
  applyPendingSnap: (draftId) =>
    set((s) => {
      const snap = s.pendingSnaps.get(draftId);
      if (!snap) return {};
      const drafts = s.draftIgnoreAreas.map((d) =>
        d.id === draftId ? { ...d, selector: snap.selector } : d,
      );
      const nextPending = new Map(s.pendingSnaps);
      nextPending.delete(draftId);
      return { draftIgnoreAreas: drafts, pendingSnaps: nextPending };
    }),
  dismissPendingSnap: (draftId) =>
    set((s) => {
      if (!s.pendingSnaps.has(draftId)) return {};
      const next = new Map(s.pendingSnaps);
      next.delete(draftId);
      return { pendingSnaps: next };
    }),
  clearSelectorForSelected: () =>
    set((s) => {
      const id = s.selectedIgnoreId;
      if (!id) return {};
      // Saved region: explicit-null override (the save payload builder
      // converts `null` to an omitted `selector` field on the wire).
      const savedRun = s.savedRunIgnoreAreas.find((r) => r.id === id);
      const savedVar = s.savedVariationIgnoreAreas.find((r) => r.id === id);
      if (savedRun || savedVar) {
        const next = new Map(s.selectorOverrides);
        next.set(id, null);
        return { selectorOverrides: next };
      }
      // Draft: mutate in place (same pattern as setKindForSelected).
      const drafts = s.draftIgnoreAreas.map((d) =>
        d.id === id ? { ...d, selector: undefined } : d,
      );
      return { draftIgnoreAreas: drafts };
    }),
  discardIgnoreChanges: () =>
    set({
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      paddingOverrides: new Map(),
      kindOverrides: new Map(),
      thresholdOverrides: new Map(),
      pendingSnaps: new Map(),
      selectorOverrides: new Map(),
      selectedIgnoreId: null,
      isTemporaryMode: false,
    }),
  applySaveSuccess: (scope) =>
    set((s) => {
      const survivors = (
        scope === "run" ? s.savedRunIgnoreAreas : s.savedVariationIgnoreAreas
      )
        .filter((r) => !s.markedForDeletion.has(r.id))
        .map((r) => {
          const kindOv = s.kindOverrides.get(r.id);
          const selectorOv = s.selectorOverrides.get(r.id);
          const thresholdOv = s.thresholdOverrides.has(r.id)
            ? s.thresholdOverrides.get(r.id)
            : r.thresholdOverride;
          return {
            ...r,
            paddingPx: s.paddingOverrides.get(r.id) ?? r.paddingPx,
            kind: kindOv?.kind ?? r.kind,
            pattern: kindOv ? kindOv.pattern : r.pattern,
            // `selectorOv === null` is the explicit-clear signal from
            // `clearSelectorForSelected`. `undefined` means "no override,"
            // so the saved row's existing selector survives.
            selector:
              selectorOv === null ? undefined : (selectorOv ?? r.selector),
            thresholdOverride: thresholdOv,
          };
        });
      const newSaved = [...survivors, ...s.draftIgnoreAreas];
      return {
        ...(scope === "run"
          ? { savedRunIgnoreAreas: newSaved }
          : { savedVariationIgnoreAreas: newSaved }),
        draftIgnoreAreas: [],
        markedForDeletion: new Set(),
        paddingOverrides: new Map(),
        kindOverrides: new Map(),
        thresholdOverrides: new Map(),
        pendingSnaps: new Map(),
        selectorOverrides: new Map(),
        selectedIgnoreId: null,
      };
    }),
}));

/**
 * Padding value to show on the slider for the currently-selected region.
 * Precedence (highest → lowest): override map → draft region's own
 * paddingPx → saved region's persisted paddingPx → 0.
 */
export function selectSelectedPaddingPx(
  s: Pick<
    State,
    | "selectedIgnoreId"
    | "paddingOverrides"
    | "draftIgnoreAreas"
    | "savedRunIgnoreAreas"
    | "savedVariationIgnoreAreas"
  >,
): number {
  if (!s.selectedIgnoreId) return 0;
  const override = s.paddingOverrides.get(s.selectedIgnoreId);
  if (override !== undefined) return override;
  const draft = s.draftIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  if (draft) return draft.paddingPx;
  const saved =
    s.savedRunIgnoreAreas.find((r) => r.id === s.selectedIgnoreId) ??
    s.savedVariationIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  return saved?.paddingPx ?? 0;
}

/**
 * Kind + pattern for the currently-selected region. Precedence
 * (highest → lowest): kindOverrides map → draft region's own
 * kind/pattern → saved region's persisted kind/pattern → defaults
 * `{ kind: "ignore", pattern: undefined }`.
 */
export function selectSelectedKindAndPattern(
  s: Pick<
    State,
    | "selectedIgnoreId"
    | "kindOverrides"
    | "draftIgnoreAreas"
    | "savedRunIgnoreAreas"
    | "savedVariationIgnoreAreas"
  >,
): { kind: IgnoreArea["kind"]; pattern?: string } {
  if (!s.selectedIgnoreId) return { kind: "ignore", pattern: undefined };
  const override = s.kindOverrides.get(s.selectedIgnoreId);
  if (override) return { kind: override.kind, pattern: override.pattern };
  const draft = s.draftIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  if (draft) return { kind: draft.kind, pattern: draft.pattern };
  const saved =
    s.savedRunIgnoreAreas.find((r) => r.id === s.selectedIgnoreId) ??
    s.savedVariationIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  return saved
    ? { kind: saved.kind, pattern: saved.pattern }
    : { kind: "ignore", pattern: undefined };
}

/**
 * F-a/3: effective selector for the currently-selected region. Precedence
 * (highest → lowest): `selectorOverrides` map (`null` = explicit clear) →
 * draft region's own `selector` → saved region's persisted `selector` →
 * `undefined`. Returns `undefined` whenever there's no selector to show
 * (the toolbar uses this to switch between "Anchor to <selector>" and
 * the static "🔗 <selector>" affordance).
 */
export function selectSelectedSelector(
  s: Pick<
    State,
    | "selectedIgnoreId"
    | "selectorOverrides"
    | "draftIgnoreAreas"
    | "savedRunIgnoreAreas"
    | "savedVariationIgnoreAreas"
  >,
): string | undefined {
  if (!s.selectedIgnoreId) return undefined;
  const override = s.selectorOverrides.get(s.selectedIgnoreId);
  if (override === null) return undefined; // explicit clear
  if (override !== undefined) return override;
  const draft = s.draftIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  if (draft) return draft.selector;
  const saved =
    s.savedRunIgnoreAreas.find((r) => r.id === s.selectedIgnoreId) ??
    s.savedVariationIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  return saved?.selector;
}

/**
 * Threshold override value to show for the currently-selected STRICT region.
 * Precedence (highest → lowest): thresholdOverrides map → draft region's
 * own thresholdOverride → saved region's persisted thresholdOverride →
 * undefined.
 */
export function selectSelectedThresholdOverride(
  s: Pick<
    State,
    | "selectedIgnoreId"
    | "thresholdOverrides"
    | "draftIgnoreAreas"
    | "savedRunIgnoreAreas"
    | "savedVariationIgnoreAreas"
  >,
): number | undefined {
  if (!s.selectedIgnoreId) return undefined;
  if (s.thresholdOverrides.has(s.selectedIgnoreId)) {
    return s.thresholdOverrides.get(s.selectedIgnoreId);
  }
  const draft = s.draftIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  if (draft) return draft.thresholdOverride;
  const saved =
    s.savedRunIgnoreAreas.find((r) => r.id === s.selectedIgnoreId) ??
    s.savedVariationIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  return saved?.thresholdOverride;
}

/**
 * Resolves the current effective state of the selected region — for a
 * draft, returns the draft as-is; for a saved region, applies any
 * unsaved padding + kind/pattern overrides. Used by the Copy action so
 * the clipboard captures what the user sees on canvas, not the
 * server-persisted bytes.
 */
export function selectEffectiveRegion(
  s: Pick<
    State,
    | "selectedIgnoreId"
    | "draftIgnoreAreas"
    | "savedRunIgnoreAreas"
    | "savedVariationIgnoreAreas"
    | "paddingOverrides"
    | "kindOverrides"
  >,
): IgnoreArea | null {
  if (!s.selectedIgnoreId) return null;
  const draft = s.draftIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  if (draft) return draft;
  const saved =
    s.savedRunIgnoreAreas.find((r) => r.id === s.selectedIgnoreId) ??
    s.savedVariationIgnoreAreas.find((r) => r.id === s.selectedIgnoreId);
  if (!saved) return null;
  const padOv = s.paddingOverrides.get(saved.id);
  const kindOv = s.kindOverrides.get(saved.id);
  return {
    ...saved,
    paddingPx: padOv ?? saved.paddingPx,
    kind: kindOv?.kind ?? saved.kind,
    pattern: kindOv ? kindOv.pattern : saved.pattern,
  };
}
