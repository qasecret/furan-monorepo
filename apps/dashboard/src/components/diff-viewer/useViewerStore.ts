import { create } from "zustand";

export type ViewerMode =
  | "side-by-side"
  | "overlay"
  | "onion-skin"
  | "diff-heatmap";

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
}

/**
 * A draft region created by the user but not yet saved. Identical shape to
 * `IgnoreArea` (the wire format requires `viewport`) plus an id assigned
 * at creation time so React can key the layer's child Graphics objects.
 */
export type DraftIgnoreArea = IgnoreArea;

export type IgnoreEditMode = "off" | "run" | "variation";

interface State {
  mode: ViewerMode;
  opacity: number;
  selectedRegionId: string | null;
  viewport: string;
  commentPanelOpen: boolean;

  // ADR-031 ignore-region editor state.
  ignoreEditMode: IgnoreEditMode;
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
  selectedIgnoreId: string | null;

  setMode: (mode: ViewerMode) => void;
  setOpacity: (opacity: number) => void;
  setSelected: (id: string | null) => void;
  setViewport: (viewport: string) => void;
  setCommentPanelOpen: (open: boolean) => void;

  setIgnoreEditMode: (mode: IgnoreEditMode) => void;
  hydrateSavedIgnoreAreas: (
    run: Array<Omit<IgnoreArea, "id">>,
    variation: Array<Omit<IgnoreArea, "id">>,
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
  /** Wipes drafts, markedForDeletion, and paddingOverrides. */
  discardIgnoreChanges: () => void;
  /**
   * Called after a successful save mutation: clears markedForDeletion +
   * paddingOverrides, promotes drafts to the matching saved slice (based
   * on scope), and clears the draft slice.
   */
  applySaveSuccess: (scope: "run" | "variation") => void;
}

export const useViewerStore = create<State>((set) => ({
  mode: "side-by-side",
  opacity: 0.5,
  selectedRegionId: null,
  viewport: "",
  commentPanelOpen: false,

  ignoreEditMode: "off",
  savedRunIgnoreAreas: [],
  savedVariationIgnoreAreas: [],
  draftIgnoreAreas: [],
  markedForDeletion: new Set(),
  paddingOverrides: new Map(),
  selectedIgnoreId: null,

  setMode: (mode) => set({ mode }),
  setOpacity: (opacity) => set({ opacity }),
  setSelected: (selectedRegionId) => set({ selectedRegionId }),
  setViewport: (viewport) => set({ viewport }),
  setCommentPanelOpen: (commentPanelOpen) => set({ commentPanelOpen }),

  setIgnoreEditMode: (ignoreEditMode) => set({ ignoreEditMode }),
  hydrateSavedIgnoreAreas: (run, variation) =>
    set((s) => {
      const hasUnsaved =
        s.draftIgnoreAreas.length > 0 ||
        s.markedForDeletion.size > 0 ||
        s.paddingOverrides.size > 0;
      const saved = {
        savedRunIgnoreAreas: run.map((r) => ({
          ...r,
          id: crypto.randomUUID(),
          paddingPx: r.paddingPx ?? 0,
        })),
        savedVariationIgnoreAreas: variation.map((r) => ({
          ...r,
          id: crypto.randomUUID(),
          paddingPx: r.paddingPx ?? 0,
        })),
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
  discardIgnoreChanges: () =>
    set({
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      paddingOverrides: new Map(),
      selectedIgnoreId: null,
    }),
  applySaveSuccess: (scope) =>
    set((s) => {
      const survivors = (
        scope === "run" ? s.savedRunIgnoreAreas : s.savedVariationIgnoreAreas
      )
        .filter((r) => !s.markedForDeletion.has(r.id))
        .map((r) => ({
          ...r,
          paddingPx: s.paddingOverrides.get(r.id) ?? r.paddingPx,
        }));
      const newSaved = [...survivors, ...s.draftIgnoreAreas];
      return {
        ...(scope === "run"
          ? { savedRunIgnoreAreas: newSaved }
          : { savedVariationIgnoreAreas: newSaved }),
        draftIgnoreAreas: [],
        markedForDeletion: new Set(),
        paddingOverrides: new Map(),
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
