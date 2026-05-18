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
  /** Wipes drafts and clears markedForDeletion. */
  discardIgnoreChanges: () => void;
  /**
   * Called after a successful save mutation: clears markedForDeletion,
   * promotes drafts to the matching saved slice (based on scope), and
   * clears the draft slice.
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
        s.draftIgnoreAreas.length > 0 || s.markedForDeletion.size > 0;
      const saved = {
        savedRunIgnoreAreas: run.map((r) => ({
          ...r,
          id: crypto.randomUUID(),
        })),
        savedVariationIgnoreAreas: variation.map((r) => ({
          ...r,
          id: crypto.randomUUID(),
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
  discardIgnoreChanges: () =>
    set({
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      selectedIgnoreId: null,
    }),
  applySaveSuccess: (scope) =>
    set((s) => {
      const survivors = (
        scope === "run" ? s.savedRunIgnoreAreas : s.savedVariationIgnoreAreas
      ).filter((r) => !s.markedForDeletion.has(r.id));
      const newSaved = [...survivors, ...s.draftIgnoreAreas];
      return {
        ...(scope === "run"
          ? { savedRunIgnoreAreas: newSaved }
          : { savedVariationIgnoreAreas: newSaved }),
        draftIgnoreAreas: [],
        markedForDeletion: new Set(),
        selectedIgnoreId: null,
      };
    }),
}));
