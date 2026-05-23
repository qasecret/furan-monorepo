import { beforeEach, describe, expect, it, test } from "vitest";

import {
  selectEffectiveRegion,
  selectSelectedKindAndPattern,
  selectSelectedPaddingPx,
  selectSelectedSelector,
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
      thresholdOverrides: new Map(),
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

  test.each(["strict", "layout", "content"] as const)(
    "setKindForSelected accepts new region mode '%s' on a draft (no pattern)",
    (newKind) => {
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
      useViewerStore.getState().setKindForSelected(newKind);
      const draft = useViewerStore.getState().draftIgnoreAreas[0]!;
      expect(draft.kind).toBe(newKind);
      // pattern is dynamic-text-only — must be cleared on a non-dynamic-text flip.
      expect(draft.pattern).toBeUndefined();
    },
  );

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

  test("selectEffectiveRegion merges saved + paddingOverride + kindOverride", () => {
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
    // Saved baseline
    expect(selectEffectiveRegion(useViewerStore.getState())).toEqual({
      id: savedId,
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      viewport: "1280x720",
      paddingPx: 0,
      kind: "ignore",
      pattern: undefined,
    });
    // Apply both overrides
    useViewerStore.getState().setPaddingForSelected(8);
    useViewerStore.getState().setKindForSelected("dynamic-text", "\\d{4}");
    expect(selectEffectiveRegion(useViewerStore.getState())).toEqual({
      id: savedId,
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      viewport: "1280x720",
      paddingPx: 8,
      kind: "dynamic-text",
      pattern: "\\d{4}",
    });
  });

  test("selectEffectiveRegion returns null without selection", () => {
    useViewerStore.getState().setSelectedIgnoreId(null);
    expect(selectEffectiveRegion(useViewerStore.getState())).toBeNull();
  });

  test("selectEffectiveRegion returns draft as-is", () => {
    const draftId = crypto.randomUUID();
    useViewerStore.getState().addDraftRegion({
      id: draftId,
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      viewport: "1280x720",
      paddingPx: 2,
      kind: "dynamic-text",
      pattern: "[a-z]+",
    });
    useViewerStore.getState().setSelectedIgnoreId(draftId);
    expect(selectEffectiveRegion(useViewerStore.getState())).toEqual({
      id: draftId,
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      viewport: "1280x720",
      paddingPx: 2,
      kind: "dynamic-text",
      pattern: "[a-z]+",
    });
  });

  test("setThresholdForSelected on a strict draft mutates the draft in place", () => {
    const draftId = crypto.randomUUID();
    useViewerStore.getState().addDraftRegion({
      id: draftId,
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      viewport: VP,
      paddingPx: 0,
      kind: "strict",
    });
    useViewerStore.getState().setSelectedIgnoreId(draftId);
    useViewerStore.getState().setThresholdForSelected(0.005);
    const draft = useViewerStore.getState().draftIgnoreAreas[0]!;
    expect(draft.thresholdOverride).toBe(0.005);
    expect(useViewerStore.getState().thresholdOverrides.size).toBe(0);
  });

  test("setThresholdForSelected on a saved strict region records an override", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: VP,
          paddingPx: 0,
          kind: "strict",
        },
      ],
      [],
    );
    const id = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(id);
    useViewerStore.getState().setThresholdForSelected(0.01);
    expect(
      useViewerStore.getState().savedRunIgnoreAreas[0]!.thresholdOverride,
    ).toBeUndefined();
    expect(useViewerStore.getState().thresholdOverrides.get(id)).toBe(0.01);
  });

  test("setThresholdForSelected(undefined) clears the override", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: VP,
          paddingPx: 0,
          kind: "strict",
          thresholdOverride: 0.02,
        },
      ],
      [],
    );
    const id = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(id);
    useViewerStore.getState().setThresholdForSelected(undefined);
    expect(
      useViewerStore.getState().thresholdOverrides.get(id),
    ).toBeUndefined();
    expect(useViewerStore.getState().thresholdOverrides.has(id)).toBe(true); // explicit clear marker
  });

  test("discardIgnoreChanges wipes thresholdOverrides", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: VP,
          paddingPx: 0,
          kind: "strict",
        },
      ],
      [],
    );
    const id = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(id);
    useViewerStore.getState().setThresholdForSelected(0.03);
    useViewerStore.getState().discardIgnoreChanges();
    expect(useViewerStore.getState().thresholdOverrides.size).toBe(0);
  });

  test("applySaveSuccess promotes thresholdOverride onto the saved region", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: VP,
          paddingPx: 0,
          kind: "strict",
          thresholdOverride: 0.01,
        },
      ],
      [],
    );
    const id = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(id);
    useViewerStore.getState().setThresholdForSelected(0.04);
    useViewerStore.getState().applySaveSuccess("run");
    const after = useViewerStore.getState().savedRunIgnoreAreas[0]!;
    expect(after.thresholdOverride).toBe(0.04);
    expect(useViewerStore.getState().thresholdOverrides.size).toBe(0);
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

describe("useViewerStore — pendingSnaps + selectorOverrides lifecycle (F-a/3)", () => {
  beforeEach(() => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      savedRunIgnoreAreas: [],
      savedVariationIgnoreAreas: [],
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      paddingOverrides: new Map(),
      kindOverrides: new Map(),
      pendingSnaps: new Map(),
      selectorOverrides: new Map(),
      selectedIgnoreId: null,
    });
  });

  it("hydrates selector through hydrateSavedIgnoreAreas", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
          selector: "#login",
        },
      ],
      [],
    );
    const saved = useViewerStore.getState().savedRunIgnoreAreas;
    expect(saved.length).toBe(1);
    expect(saved[0]?.selector).toBe("#login");
  });

  it("proposePendingSnap is idempotent on same draft id (first wins)", () => {
    const id = "draft-1";
    useViewerStore.getState().proposePendingSnap(id, {
      selector: "#x",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    });
    useViewerStore.getState().proposePendingSnap(id, {
      selector: "#y",
      bbox: { x: 5, y: 5, width: 20, height: 20 },
    });
    const snap = useViewerStore.getState().pendingSnaps.get(id);
    expect(snap?.selector).toBe("#x");
    expect(useViewerStore.getState().pendingSnaps.size).toBe(1);
  });

  it("applyPendingSnap writes selector onto the draft + clears the pending entry", () => {
    const id = "draft-2";
    useViewerStore.setState({
      draftIgnoreAreas: [
        {
          id,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
    });
    useViewerStore.getState().proposePendingSnap(id, {
      selector: "#applied",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    });
    useViewerStore.getState().applyPendingSnap(id);
    const draft = useViewerStore
      .getState()
      .draftIgnoreAreas.find((d) => d.id === id);
    expect(draft?.selector).toBe("#applied");
    expect(useViewerStore.getState().pendingSnaps.has(id)).toBe(false);
  });

  it("applyPendingSnap is a no-op when nothing is pending for the draft", () => {
    useViewerStore.setState({
      draftIgnoreAreas: [
        {
          id: "lonely",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
    });
    useViewerStore.getState().applyPendingSnap("lonely");
    const draft = useViewerStore.getState().draftIgnoreAreas[0]!;
    expect(draft.selector).toBeUndefined();
  });

  it("dismissPendingSnap clears the entry without touching the draft", () => {
    const id = "draft-3";
    useViewerStore.setState({
      draftIgnoreAreas: [
        {
          id,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
    });
    useViewerStore.getState().proposePendingSnap(id, {
      selector: "#x",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    });
    useViewerStore.getState().dismissPendingSnap(id);
    const draft = useViewerStore
      .getState()
      .draftIgnoreAreas.find((d) => d.id === id);
    expect(draft?.selector).toBeUndefined();
    expect(useViewerStore.getState().pendingSnaps.has(id)).toBe(false);
  });

  it("clearSelectorForSelected sets a null override on a saved region", () => {
    const savedId = "saved-1";
    useViewerStore.setState({
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
          selector: "#hydrated",
        },
      ],
      selectedIgnoreId: savedId,
    });
    useViewerStore.getState().clearSelectorForSelected();
    expect(useViewerStore.getState().selectorOverrides.get(savedId)).toBeNull();
    // Saved row itself unchanged — override carries the clear.
    expect(useViewerStore.getState().savedRunIgnoreAreas[0]!.selector).toBe(
      "#hydrated",
    );
  });

  it("clearSelectorForSelected mutates a draft in place", () => {
    const draftId = "draft-4";
    useViewerStore.setState({
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
          selector: "#to-clear",
        },
      ],
      selectedIgnoreId: draftId,
    });
    useViewerStore.getState().clearSelectorForSelected();
    const draft = useViewerStore
      .getState()
      .draftIgnoreAreas.find((d) => d.id === draftId);
    expect(draft?.selector).toBeUndefined();
    expect(useViewerStore.getState().selectorOverrides.size).toBe(0);
  });

  it("clearSelectorForSelected is a no-op when nothing selected", () => {
    useViewerStore.setState({ selectedIgnoreId: null });
    useViewerStore.getState().clearSelectorForSelected();
    expect(useViewerStore.getState().selectorOverrides.size).toBe(0);
  });

  it("discardIgnoreChanges resets pendingSnaps + selectorOverrides", () => {
    useViewerStore.setState({
      pendingSnaps: new Map([
        ["x", { selector: "#x", bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      ]),
      selectorOverrides: new Map([["y", null]]),
    });
    useViewerStore.getState().discardIgnoreChanges();
    expect(useViewerStore.getState().pendingSnaps.size).toBe(0);
    expect(useViewerStore.getState().selectorOverrides.size).toBe(0);
  });

  it("selectSelectedSelector prefers override > draft > saved > undefined", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
          selector: "#saved-sel",
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.getState().setSelectedIgnoreId(savedId);
    // Saved without override → saved.selector.
    expect(selectSelectedSelector(useViewerStore.getState())).toBe(
      "#saved-sel",
    );
    // Null override → undefined (explicit clear).
    useViewerStore.setState({
      selectorOverrides: new Map([[savedId, null]]),
    });
    expect(selectSelectedSelector(useViewerStore.getState())).toBeUndefined();
    // String override → that string.
    useViewerStore.setState({
      selectorOverrides: new Map([[savedId, "#override"]]),
    });
    expect(selectSelectedSelector(useViewerStore.getState())).toBe("#override");
    // Nothing selected → undefined.
    useViewerStore.getState().setSelectedIgnoreId(null);
    expect(selectSelectedSelector(useViewerStore.getState())).toBeUndefined();
  });

  it("applySaveSuccess folds selectorOverrides into surviving saved rows", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [
        {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
          selector: "#initial",
        },
      ],
      [],
    );
    const savedId = useViewerStore.getState().savedRunIgnoreAreas[0]!.id;
    useViewerStore.setState({
      selectorOverrides: new Map([[savedId, null]]),
    });
    useViewerStore.getState().applySaveSuccess("run");
    const after = useViewerStore.getState().savedRunIgnoreAreas[0]!;
    expect(after.selector).toBeUndefined();
    expect(useViewerStore.getState().selectorOverrides.size).toBe(0);
    expect(useViewerStore.getState().pendingSnaps.size).toBe(0);
  });
});
