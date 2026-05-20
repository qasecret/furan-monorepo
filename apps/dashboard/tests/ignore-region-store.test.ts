import { beforeEach, describe, expect, it, test } from "vitest";

import {
  selectSelectedKindAndPattern,
  selectSelectedPaddingPx,
  useViewerStore,
} from "../src/components/diff-viewer/useViewerStore";

const VP = "1280x720";

function plainRegion(over: Partial<{ x: number; y: number }> = {}) {
  return {
    x: 10,
    y: 10,
    width: 20,
    height: 20,
    viewport: VP,
    paddingPx: 0,
    kind: "ignore" as const,
    ...over,
  };
}

describe("useViewerStore — ignore-region slice", () => {
  beforeEach(() => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      savedRunIgnoreAreas: [],
      savedVariationIgnoreAreas: [],
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      paddingOverrides: new Map(),
      kindOverrides: new Map(),
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

  it("hydrateSavedIgnoreAreas assigns client ids and clears local state when nothing is unsaved", () => {
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

  it("hydrateSavedIgnoreAreas preserves drafts + markedForDeletion when unsaved changes exist", () => {
    // Set up unsaved local state.
    useViewerStore.setState({
      draftIgnoreAreas: [{ id: "d1", ...plainRegion() }],
      markedForDeletion: new Set(["s1"]),
      selectedIgnoreId: "d1",
    });
    // Spurious refetch hydration:
    useViewerStore
      .getState()
      .hydrateSavedIgnoreAreas([plainRegion({ x: 5 })], []);

    const s = useViewerStore.getState();
    // Server-derived slices updated:
    expect(s.savedRunIgnoreAreas).toHaveLength(1);
    expect(s.savedRunIgnoreAreas[0]!.x).toBe(5);
    // Unsaved local state PRESERVED:
    expect(s.draftIgnoreAreas).toHaveLength(1);
    expect(s.draftIgnoreAreas[0]!.id).toBe("d1");
    expect(s.markedForDeletion.has("s1")).toBe(true);
    expect(s.selectedIgnoreId).toBe("d1");
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
    expect(state.selectedIgnoreId).toBeNull();
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
    expect(state.selectedIgnoreId).toBeNull();
  });

  test("setPaddingForSelected on a draft region mutates in place", () => {
    const draftId = crypto.randomUUID();
    useViewerStore.getState().addDraftRegion({
      id: draftId,
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      viewport: "1280x720",
      paddingPx: 0,
      kind: "ignore",
    });
    useViewerStore.getState().setSelectedIgnoreId(draftId);
    useViewerStore.getState().setPaddingForSelected(8);
    const state = useViewerStore.getState();
    expect(state.draftIgnoreAreas[0]!.paddingPx).toBe(8);
    expect(state.paddingOverrides.size).toBe(0);
  });

  test("setPaddingForSelected on a saved region records an override", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    useViewerStore.getState().setPaddingForSelected(4);
    const state = useViewerStore.getState();
    expect(state.savedRunIgnoreAreas[0]!.paddingPx).toBe(0); // saved unchanged
    expect(state.paddingOverrides.get(savedId)).toBe(4);
  });

  test("setPaddingForSelected is a no-op when nothing selected", () => {
    useViewerStore.getState().setSelectedIgnoreId(null);
    useViewerStore.getState().setPaddingForSelected(4);
    expect(useViewerStore.getState().paddingOverrides.size).toBe(0);
  });

  test("discardIgnoreChanges clears paddingOverrides", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    useViewerStore.getState().setPaddingForSelected(4);
    expect(useViewerStore.getState().paddingOverrides.size).toBe(1);
    useViewerStore.getState().discardIgnoreChanges();
    expect(useViewerStore.getState().paddingOverrides.size).toBe(0);
  });

  test("applySaveSuccess clears paddingOverrides", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    useViewerStore.getState().setPaddingForSelected(4);
    useViewerStore.getState().applySaveSuccess("run");
    expect(useViewerStore.getState().paddingOverrides.size).toBe(0);
  });

  test("hydrateSavedIgnoreAreas defaults kind to 'ignore' when missing", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
        },
      ],
      [],
    );
    expect(useViewerStore.getState().savedRunIgnoreAreas[0]!.kind).toBe(
      "ignore",
    );
  });

  test("setKindForSelected on a draft region mutates kind + pattern in place", () => {
    const draftId = crypto.randomUUID();
    useViewerStore.getState().addDraftRegion({
      id: draftId,
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      viewport: "1280x720",
      paddingPx: 0,
      kind: "ignore",
    });
    useViewerStore.getState().setSelectedIgnoreId(draftId);
    useViewerStore.getState().setKindForSelected("dynamic-text", "\\d{4}");
    const draft = useViewerStore.getState().draftIgnoreAreas[0]!;
    expect(draft.kind).toBe("dynamic-text");
    expect(draft.pattern).toBe("\\d{4}");
    expect(useViewerStore.getState().kindOverrides.size).toBe(0);
  });

  test("setKindForSelected on a saved region records an override", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    useViewerStore.getState().setKindForSelected("dynamic-text", "\\d{4}");
    const state = useViewerStore.getState();
    expect(state.savedRunIgnoreAreas[0]!.kind).toBe("ignore"); // saved unchanged
    expect(state.kindOverrides.get(savedId)).toEqual({
      kind: "dynamic-text",
      pattern: "\\d{4}",
    });
  });

  test("setKindForSelected to 'ignore' clears pattern in the override", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "dynamic-text",
          pattern: "\\d{4}",
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    useViewerStore.getState().setKindForSelected("ignore");
    expect(useViewerStore.getState().kindOverrides.get(savedId)).toEqual({
      kind: "ignore",
      pattern: undefined,
    });
  });

  test("discardIgnoreChanges clears kindOverrides", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    useViewerStore.getState().setKindForSelected("dynamic-text", "\\d{4}");
    useViewerStore.getState().discardIgnoreChanges();
    expect(useViewerStore.getState().kindOverrides.size).toBe(0);
  });

  test("applySaveSuccess clears kindOverrides", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    useViewerStore.getState().setKindForSelected("dynamic-text", "\\d{4}");
    useViewerStore.getState().applySaveSuccess("run");
    expect(useViewerStore.getState().kindOverrides.size).toBe(0);
  });

  test("selectSelectedKindAndPattern returns override > draft > saved > defaults", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "dynamic-text",
          pattern: "saved-pat",
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    // saved without override
    expect(selectSelectedKindAndPattern(useViewerStore.getState())).toEqual({
      kind: "dynamic-text",
      pattern: "saved-pat",
    });
    // override wins
    useViewerStore.getState().setKindForSelected("ignore");
    expect(selectSelectedKindAndPattern(useViewerStore.getState())).toEqual({
      kind: "ignore",
      pattern: undefined,
    });
    // no selection → defaults
    useViewerStore.getState().setSelectedIgnoreId(null);
    expect(selectSelectedKindAndPattern(useViewerStore.getState())).toEqual({
      kind: "ignore",
      pattern: undefined,
    });
  });

  test("selectSelectedPaddingPx prefers override > draft > saved.paddingPx > 0", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 2,
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    // Saved without override → returns saved.paddingPx
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    expect(selectSelectedPaddingPx(useViewerStore.getState())).toBe(2);
    // Override > saved
    useViewerStore.getState().setPaddingForSelected(7);
    expect(selectSelectedPaddingPx(useViewerStore.getState())).toBe(7);
    // No selection → 0
    useViewerStore.getState().setSelectedIgnoreId(null);
    expect(selectSelectedPaddingPx(useViewerStore.getState())).toBe(0);
  });
});
