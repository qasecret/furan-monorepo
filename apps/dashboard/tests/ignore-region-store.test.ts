import { beforeEach, describe, expect, it } from "vitest";

import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";

const VP = "1280x720";

function plainRegion(over: Partial<{ x: number; y: number }> = {}) {
  return { x: 10, y: 10, width: 20, height: 20, viewport: VP, ...over };
}

describe("useViewerStore — ignore-region slice", () => {
  beforeEach(() => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      savedRunIgnoreAreas: [],
      savedVariationIgnoreAreas: [],
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      selectedIgnoreId: null,
    });
  });

  it("setIgnoreEditMode transitions off → run → variation → off", () => {
    const s = useViewerStore.getState();
    s.setIgnoreEditMode("run");
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
    s.setIgnoreEditMode("variation");
    expect(useViewerStore.getState().ignoreEditMode).toBe("variation");
    s.setIgnoreEditMode("off");
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
  });

  it("hydrateSavedIgnoreAreas assigns client ids and resets local edit state", () => {
    useViewerStore.setState({
      draftIgnoreAreas: [{ id: "stale", ...plainRegion() }],
      markedForDeletion: new Set(["stale-saved-id"]),
      selectedIgnoreId: "anything",
    });
    useViewerStore
      .getState()
      .hydrateSavedIgnoreAreas([plainRegion()], [plainRegion({ x: 200 })]);

    const s = useViewerStore.getState();
    expect(s.savedRunIgnoreAreas).toHaveLength(1);
    expect(s.savedRunIgnoreAreas[0]!.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(s.savedVariationIgnoreAreas).toHaveLength(1);
    expect(s.savedVariationIgnoreAreas[0]!.x).toBe(200);
    expect(s.draftIgnoreAreas).toEqual([]);
    expect(s.markedForDeletion.size).toBe(0);
    expect(s.selectedIgnoreId).toBeNull();
  });

  it("addDraftRegion appends to draftIgnoreAreas", () => {
    const s = useViewerStore.getState();
    s.addDraftRegion({ id: "d1", ...plainRegion() });
    s.addDraftRegion({ id: "d2", ...plainRegion({ x: 100 }) });
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(2);
  });

  it("deleteSelected removes the selected draft", () => {
    const s = useViewerStore.getState();
    s.addDraftRegion({ id: "d1", ...plainRegion() });
    s.addDraftRegion({ id: "d2", ...plainRegion({ x: 100 }) });
    s.setSelectedIgnoreId("d1");
    s.deleteSelected();
    const state = useViewerStore.getState();
    expect(state.draftIgnoreAreas.map((r) => r.id)).toEqual(["d2"]);
    expect(state.selectedIgnoreId).toBeNull();
  });

  it("deleteSelected on a saved region adds it to markedForDeletion", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas([plainRegion()], []);
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    const s = useViewerStore.getState();
    s.setSelectedIgnoreId(savedId);
    s.deleteSelected();
    const state = useViewerStore.getState();
    expect(state.markedForDeletion.has(savedId)).toBe(true);
    expect(state.savedRunIgnoreAreas).toHaveLength(1);
    expect(state.selectedIgnoreId).toBeNull();
  });

  it("deleteSelected is a no-op when nothing is selected", () => {
    useViewerStore.getState().deleteSelected();
    expect(useViewerStore.getState().selectedIgnoreId).toBeNull();
  });

  it("discardIgnoreChanges wipes drafts and markedForDeletion", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas([plainRegion()], []);
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.setState({
      draftIgnoreAreas: [{ id: "d1", ...plainRegion() }],
      markedForDeletion: new Set([savedId]),
      selectedIgnoreId: "d1",
    });
    useViewerStore.getState().discardIgnoreChanges();
    const state = useViewerStore.getState();
    expect(state.draftIgnoreAreas).toEqual([]);
    expect(state.markedForDeletion.size).toBe(0);
    expect(state.selectedIgnoreId).toBeNull();
  });

  it("applySaveSuccess(run) merges drafts into savedRunIgnoreAreas and drops marked", () => {
    useViewerStore
      .getState()
      .hydrateSavedIgnoreAreas([plainRegion(), plainRegion({ x: 50 })], []);
    const ids = useViewerStore.getState().savedRunIgnoreAreas.map((r) => r.id);
    useViewerStore.setState({
      draftIgnoreAreas: [
        { id: "new1", ...plainRegion({ x: 300 }) },
        { id: "new2", ...plainRegion({ x: 400 }) },
      ],
      markedForDeletion: new Set([ids[0]!]),
    });
    useViewerStore.getState().applySaveSuccess("run");

    const state = useViewerStore.getState();
    expect(state.savedRunIgnoreAreas).toHaveLength(3);
    expect(
      state.savedRunIgnoreAreas.find((r) => r.id === ids[0]!),
    ).toBeUndefined();
    expect(
      state.savedRunIgnoreAreas.find((r) => r.id === ids[1]!),
    ).toBeDefined();
    expect(state.draftIgnoreAreas).toEqual([]);
    expect(state.markedForDeletion.size).toBe(0);
  });

  it("applySaveSuccess(variation) merges drafts into savedVariationIgnoreAreas; run slice untouched", () => {
    useViewerStore
      .getState()
      .hydrateSavedIgnoreAreas([plainRegion()], [plainRegion({ x: 50 })]);
    const runIdBefore = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.setState({
      draftIgnoreAreas: [{ id: "newV", ...plainRegion({ x: 600 }) }],
    });
    useViewerStore.getState().applySaveSuccess("variation");

    const state = useViewerStore.getState();
    expect(state.savedVariationIgnoreAreas).toHaveLength(2);
    expect(state.savedRunIgnoreAreas).toHaveLength(1);
    expect(state.savedRunIgnoreAreas[0]!.id).toBe(runIdBefore);
    expect(state.draftIgnoreAreas).toEqual([]);
  });
});
