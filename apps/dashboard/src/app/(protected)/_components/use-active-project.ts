"use client";

import { create } from "zustand";

/**
 * The project the user is currently inside (`/projects/<id>/…`), surfaced so
 * the flat sidebar can show an active-project context row beneath "Projects".
 *
 * Set + cleared by `<ProjectHeader>` (mounted by the project layout); read by
 * the sidebar. A zustand store (like `usePaletteStore`) keeps the sidebar and
 * the deep route in sync without threading state through the server shell.
 */
interface State {
  id: string | null;
  name: string | null;
  set: (id: string, name: string) => void;
  clear: () => void;
}

export const useActiveProjectStore = create<State>((set) => ({
  id: null,
  name: null,
  set: (id, name) => set({ id, name }),
  clear: () => set({ id: null, name: null }),
}));
