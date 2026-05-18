import { create } from "zustand";

export type ViewerMode =
  | "side-by-side"
  | "overlay"
  | "onion-skin"
  | "diff-heatmap";

interface State {
  mode: ViewerMode;
  opacity: number;
  selectedRegionId: string | null;
  viewport: string;
  commentPanelOpen: boolean;
  setMode: (mode: ViewerMode) => void;
  setOpacity: (opacity: number) => void;
  setSelected: (id: string | null) => void;
  setViewport: (viewport: string) => void;
  setCommentPanelOpen: (open: boolean) => void;
}

export const useViewerStore = create<State>((set) => ({
  mode: "side-by-side",
  opacity: 0.5,
  selectedRegionId: null,
  viewport: "",
  commentPanelOpen: false,
  setMode: (mode) => set({ mode }),
  setOpacity: (opacity) => set({ opacity }),
  setSelected: (selectedRegionId) => set({ selectedRegionId }),
  setViewport: (viewport) => set({ viewport }),
  setCommentPanelOpen: (commentPanelOpen) => set({ commentPanelOpen }),
}));
