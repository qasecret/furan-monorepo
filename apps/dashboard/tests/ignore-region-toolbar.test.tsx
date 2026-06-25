import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Helper: open the RegionSettingsPopover by keyboard-activating its trigger.
// Radix DropdownMenu fires on pointerdown (not click), so synthetic
// fireEvent.click on the trigger doesn't open it in jsdom — use the keyboard
// path instead (same pattern as approval-bar.test.tsx openMoreMenu).
async function openRegionSettings(): Promise<void> {
  const trigger = screen.getByTestId(
    "region-settings-trigger",
  ) as HTMLButtonElement;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  // Allow Radix to flush its portal mount.
  await new Promise((r) => setTimeout(r, 0));
}

const setIgnoreAreasMutate = vi.fn();
const invalidate = vi.fn();
let isPending = false;

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      runs: { getById: { invalidate } },
    }),
    runs: {
      setIgnoreAreas: {
        useMutation: (opts?: {
          onSuccess?: (
            data: unknown,
            vars: { runId: string; scope: "run" | "variation" },
          ) => void;
        }) => {
          return {
            mutate: (input: {
              runId: string;
              scope: "run" | "variation";
              ignoreAreas: unknown;
            }) => {
              setIgnoreAreasMutate(input);
              opts?.onSuccess?.(undefined, {
                runId: input.runId,
                scope: input.scope,
              });
            },
            isPending,
          };
        },
      },
      // ViewerToolbar's temporary-ignore path (isTemporaryMode) calls this;
      // mirror setIgnoreAreas so the hook resolves and onSuccess can fire.
      setTempIgnoreAreas: {
        useMutation: (opts?: { onSuccess?: () => void }) => {
          return {
            mutate: () => {
              opts?.onSuccess?.();
            },
            isPending,
          };
        },
      },
      // SensitivityControl (rendered by ViewerToolbar) calls this — a no-op
      // mock keeps the toolbar tests focused on region-editor behavior
      // without coupling them to the slider's wire shape.
      setDiffThresholdOverride: {
        useMutation: () => ({
          mutate: () => undefined,
          isPending: false,
        }),
      },
    },
  },
}));

import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";
import { ViewerToolbar } from "../src/components/diff-viewer/ViewerToolbar";

const RUN_ID = "00000000-0000-0000-0000-000000000000";
const VP = "1280x720";

describe("ViewerToolbar — ignore-regions controls", () => {
  beforeEach(() => {
    setIgnoreAreasMutate.mockReset();
    invalidate.mockReset();
    isPending = false;
    sessionStorage.clear();
    useViewerStore.setState({
      mode: "side-by-side",
      opacity: 0.5,
      selectedRegionId: null,
      viewport: VP,
      commentPanelOpen: false,
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
  afterEach(() => cleanup());

  test("shows the Edit regions toggle, hides Save/Discard when off", () => {
    render(<ViewerToolbar runId={RUN_ID} />);
    expect(screen.getByTestId("edit-regions-toggle")).toBeDefined();
    expect(screen.queryByTestId("ignore-save-button")).toBeNull();
    expect(screen.queryByTestId("ignore-discard-button")).toBeNull();
  });

  test("hides the Drag/Pick input-mode toggle when the run has no element map", () => {
    useViewerStore.setState({ ignoreEditMode: "variation" });
    // hasElementMap defaults to false → "Pick element" is impossible, so the
    // whole toggle is hidden (Drag is the implicit default).
    render(<ViewerToolbar runId={RUN_ID} />);
    expect(screen.queryByTestId("region-input-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("region-input-mode-pick")).toBeNull();
  });

  test("shows the Drag/Pick toggle with Pick enabled when an element map exists", () => {
    useViewerStore.setState({ ignoreEditMode: "variation" });
    render(<ViewerToolbar runId={RUN_ID} hasElementMap />);
    expect(screen.getByTestId("region-input-mode-toggle")).toBeDefined();
    const pick = screen.getByTestId(
      "region-input-mode-pick",
    ) as HTMLButtonElement;
    expect(pick.disabled).toBe(false);
  });

  test("selecting a scope from the dropdown sets ignoreEditMode and reveals Save/Discard", () => {
    render(<ViewerToolbar runId={RUN_ID} />);
    // Bypass Radix portal: directly call the store action that the dropdown
    // item's onClick would call, then verify the toolbar re-renders correctly.
    useViewerStore.getState().setIgnoreEditMode("run");
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
    // Re-render to pick up updated store state.
    cleanup();
    render(<ViewerToolbar runId={RUN_ID} />);
    expect(screen.getByTestId("ignore-save-button")).toBeDefined();
    expect(screen.getByTestId("ignore-discard-button")).toBeDefined();
  });

  test("clicking the toggle while editing exits to off", () => {
    useViewerStore.setState({ ignoreEditMode: "variation" });
    render(<ViewerToolbar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("edit-regions-toggle"));
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
  });

  test("Save is disabled when there are no pending changes", () => {
    useViewerStore.setState({ ignoreEditMode: "run" });
    render(<ViewerToolbar runId={RUN_ID} />);
    const save = screen.getByTestId("ignore-save-button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  test("Save fires setIgnoreAreas with the right scope + payload (run)", () => {
    const draft = {
      id: "d1",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      viewport: VP,
      paddingPx: 0,
      kind: "ignore" as const,
    };
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [draft],
    });

    render(<ViewerToolbar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("ignore-save-button"));

    expect(setIgnoreAreasMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      scope: "run",
      ignoreAreas: [
        expect.objectContaining({
          x: 10,
          y: 10,
          width: 20,
          height: 20,
          viewport: VP,
          paddingPx: 0,
        }),
      ],
    });
    expect(invalidate).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  test("Save merges drafts and excludes markedForDeletion (variation scope)", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [],
      [
        { x: 1, y: 1, width: 5, height: 5, viewport: VP, paddingPx: 0 },
        { x: 2, y: 2, width: 5, height: 5, viewport: VP, paddingPx: 0 },
      ],
    );
    const ids = useViewerStore
      .getState()
      .savedVariationIgnoreAreas.map((r) => r.id);
    useViewerStore.setState({
      ignoreEditMode: "variation",
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 100,
          y: 100,
          width: 30,
          height: 30,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      markedForDeletion: new Set([ids[0]!]),
    });

    render(<ViewerToolbar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("ignore-save-button"));

    expect(setIgnoreAreasMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      scope: "variation",
      ignoreAreas: [
        expect.objectContaining({
          x: 2,
          y: 2,
          width: 5,
          height: 5,
          viewport: VP,
          paddingPx: 0,
        }),
        expect.objectContaining({
          x: 100,
          y: 100,
          width: 30,
          height: 30,
          viewport: VP,
          paddingPx: 0,
        }),
      ],
    });
  });

  test("Discard wipes drafts + markedForDeletion (store state)", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 1,
          y: 1,
          width: 10,
          height: 10,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      markedForDeletion: new Set(["x"]),
    });

    render(<ViewerToolbar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("ignore-discard-button"));
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([]);
    expect(useViewerStore.getState().markedForDeletion.size).toBe(0);
  });

  test("the single Edit-regions button enters edit mode at the variation (persist) scope", () => {
    render(<ViewerToolbar runId={RUN_ID} />);
    // Not editing → secondary "Edit regions" button; click enters edit mode.
    fireEvent.click(screen.getByTestId("edit-regions-toggle"));
    expect(useViewerStore.getState().ignoreEditMode).toBe("variation");
    // No scope dropdown / scope-switch any more.
    expect(screen.queryByTestId("scope-switch-dropdown-trigger")).toBeNull();
  });

  test("padding-control hidden when edit mode is off", () => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      selectedIgnoreId: "some-id",
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    expect(screen.queryByTestId("padding-control")).toBeNull();
  });

  test("padding-control hidden when no region selected", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      selectedIgnoreId: null,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    expect(screen.queryByTestId("padding-control")).toBeNull();
  });

  test("padding-control visible when editing + region selected", async () => {
    const draftId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    expect(screen.queryByTestId("padding-control")).not.toBeNull();
    expect(screen.getByTestId("padding-value").textContent).toBe("0px");
  });

  test("moving slider updates paddingPx on draft via setPaddingForSelected", async () => {
    const draftId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    const slider = screen.getByTestId("padding-slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "12" } });
    const state = useViewerStore.getState();
    expect(state.draftIgnoreAreas[0]!.paddingPx).toBe(12);
  });

  test("handleSave payload includes paddingPx from saved overrides + drafts", () => {
    const savedId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    const overrides = new Map<string, number>();
    overrides.set(savedId, 4);
    useViewerStore.setState({
      ignoreEditMode: "run",
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 100,
          y: 100,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 8,
          kind: "ignore",
        },
      ],
      paddingOverrides: overrides,
      selectedIgnoreId: null,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("ignore-save-button"));
    expect(setIgnoreAreasMutate).toHaveBeenCalled();
    const callArg = setIgnoreAreasMutate.mock.calls[0]![0] as {
      ignoreAreas: Array<{ paddingPx: number; x: number }>;
    };
    expect(callArg.ignoreAreas).toHaveLength(2);
    const savedPayload = callArg.ignoreAreas.find((r) => r.x === 100);
    const draftPayload = callArg.ignoreAreas.find((r) => r.x === 10);
    expect(savedPayload!.paddingPx).toBe(4); // override
    expect(draftPayload!.paddingPx).toBe(8); // draft's own
  });

  test("kind controls hidden when project.dynamicTextEnabled is false", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: "d1",
    });
    render(
      <ViewerToolbar runId={RUN_ID} project={{ dynamicTextEnabled: false }} />,
    );
    expect(screen.queryByTestId("region-kind-control")).toBeNull();
  });

  test("kind controls visible when project flag on, edit mode on, region selected", async () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: "d1",
    });
    render(
      <ViewerToolbar runId={RUN_ID} project={{ dynamicTextEnabled: true }} />,
    );
    await openRegionSettings();
    expect(screen.queryByTestId("region-kind-control")).not.toBeNull();
    expect(screen.queryByTestId("region-kind-select")).not.toBeNull();
  });

  test("switching kind to dynamic-text fills the date preset", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: "d1",
    });
    // Direct store action instead of clicking through the Radix portal; the
    // dropdown→onValueChange path calls setKindForSelected("dynamic-text", PRESETS.date)
    // and we verify the same end state.
    useViewerStore
      .getState()
      .setKindForSelected("dynamic-text", "preset-pattern");
    const state = useViewerStore.getState();
    expect(state.draftIgnoreAreas[0]!.kind).toBe("dynamic-text");
    expect(state.draftIgnoreAreas[0]!.pattern).toBeDefined();
  });

  test("handleSave payload includes kind + pattern from drafts and overrides", () => {
    const savedId = "00000000-0000-0000-0000-000000000099";
    const draftId = "00000000-0000-0000-0000-000000000077";
    const kindOverrides = new Map<
      string,
      { kind: "ignore" | "dynamic-text"; pattern?: string }
    >([[savedId, { kind: "dynamic-text", pattern: "\\d{4}" }]]);
    useViewerStore.setState({
      ignoreEditMode: "run",
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 100,
          y: 100,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "dynamic-text",
          pattern: "[a-z]+",
        },
      ],
      kindOverrides,
      selectedIgnoreId: null,
    });
    render(
      <ViewerToolbar runId={RUN_ID} project={{ dynamicTextEnabled: true }} />,
    );
    fireEvent.click(screen.getByTestId("ignore-save-button"));
    expect(setIgnoreAreasMutate).toHaveBeenCalled();
    const callArg = setIgnoreAreasMutate.mock.calls[0]![0] as {
      ignoreAreas: Array<{
        x: number;
        kind: string;
        pattern?: string;
      }>;
    };
    const saved = callArg.ignoreAreas.find((r) => r.x === 100);
    const draft = callArg.ignoreAreas.find((r) => r.x === 10);
    expect(saved!.kind).toBe("dynamic-text");
    expect(saved!.pattern).toBe("\\d{4}");
    expect(draft!.kind).toBe("dynamic-text");
    expect(draft!.pattern).toBe("[a-z]+");
  });

  test("Copy button disabled when no region selected", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      selectedIgnoreId: null,
    });
    render(
      <ViewerToolbar
        runId={RUN_ID}
        projectId="p1"
        project={{ dynamicTextEnabled: false }}
      />,
    );
    const btn = screen.getByTestId("region-copy-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  test("Copy button enabled when region selected, writes effective region to clipboard", () => {
    const savedId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 100,
          y: 100,
          width: 50,
          height: 50,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      paddingOverrides: new Map([[savedId, 8]]),
      kindOverrides: new Map([
        [savedId, { kind: "dynamic-text" as const, pattern: "\\d{4}" }],
      ]),
      selectedIgnoreId: savedId,
    });
    sessionStorage.clear();
    render(
      <ViewerToolbar
        runId={RUN_ID}
        projectId="p1"
        project={{ dynamicTextEnabled: true }}
      />,
    );
    const btn = screen.getByTestId("region-copy-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const stored = sessionStorage.getItem("furan:region-clipboard:p1");
    expect(stored).not.toBeNull();
    const entry = JSON.parse(stored!);
    expect(entry.region.paddingPx).toBe(8);
    expect(entry.region.kind).toBe("dynamic-text");
    expect(entry.region.pattern).toBe("\\d{4}");
  });

  test("Paste button disabled when clipboard empty", () => {
    sessionStorage.clear();
    useViewerStore.setState({
      ignoreEditMode: "run",
      selectedIgnoreId: null,
    });
    render(
      <ViewerToolbar
        runId={RUN_ID}
        projectId="p1"
        project={{ dynamicTextEnabled: false }}
      />,
    );
    const btn = screen.getByTestId("region-paste-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  test("Paste button enabled when clipboard has content; click creates a draft", () => {
    sessionStorage.setItem(
      "furan:region-clipboard:p1",
      JSON.stringify({
        _v: 1,
        copiedAt: 0,
        region: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          viewport: "1280x720",
          paddingPx: 4,
          kind: "ignore" as const,
        },
      }),
    );
    useViewerStore.setState({
      ignoreEditMode: "run",
      selectedIgnoreId: null,
      viewport: "1280x720",
      draftIgnoreAreas: [],
    });
    render(
      <ViewerToolbar
        runId={RUN_ID}
        projectId="p1"
        project={{ dynamicTextEnabled: false }}
      />,
    );
    const btn = screen.getByTestId("region-paste-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const drafts = useViewerStore.getState().draftIgnoreAreas;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.x).toBe(10);
    expect(drafts[0]!.paddingPx).toBe(4);
  });

  test("Paste retags viewport to current viewer's active viewport", () => {
    sessionStorage.setItem(
      "furan:region-clipboard:p1",
      JSON.stringify({
        _v: 1,
        copiedAt: 0,
        region: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          viewport: "1280x720", // source viewport
          paddingPx: 0,
          kind: "ignore" as const,
        },
      }),
    );
    useViewerStore.setState({
      ignoreEditMode: "run",
      selectedIgnoreId: null,
      viewport: "1920x1080", // destination viewport
      draftIgnoreAreas: [],
    });
    render(
      <ViewerToolbar
        runId={RUN_ID}
        projectId="p1"
        project={{ dynamicTextEnabled: false }}
      />,
    );
    fireEvent.click(screen.getByTestId("region-paste-button"));
    expect(useViewerStore.getState().draftIgnoreAreas[0]!.viewport).toBe(
      "1920x1080",
    );
  });

  test("Copy + Paste cluster is NOT rendered outside edit mode", () => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      selectedIgnoreId: null,
    });
    render(
      <ViewerToolbar
        runId={RUN_ID}
        projectId="p1"
        project={{ dynamicTextEnabled: false }}
      />,
    );
    expect(screen.queryByTestId("region-copy-button")).toBeNull();
    expect(screen.queryByTestId("region-paste-button")).toBeNull();
  });

  // F-a/3: snap affordance + selector indicator + selector save plumbing.
  test("renders pending-snap row when selected draft has a proposal and no selector", async () => {
    const draftId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      pendingSnaps: new Map([
        [
          draftId,
          {
            selector: "#login-button",
            bbox: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      ]),
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    expect(screen.getByTestId("pending-snap-row")).toBeDefined();
    expect(screen.getByTestId("pending-snap-selector").textContent).toBe(
      "#login-button",
    );
    expect(screen.queryByTestId("selector-row")).toBeNull();
  });

  test("Apply on the pending-snap row writes selector onto the draft and hides the row", async () => {
    const draftId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      pendingSnaps: new Map([
        [
          draftId,
          {
            selector: "#cta",
            bbox: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      ]),
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    fireEvent.click(screen.getByTestId("pending-snap-apply"));
    const state = useViewerStore.getState();
    expect(state.draftIgnoreAreas[0]!.selector).toBe("#cta");
    expect(state.pendingSnaps.size).toBe(0);
  });

  test("Dismiss on the pending-snap row removes the entry without touching the draft", async () => {
    const draftId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      pendingSnaps: new Map([
        [
          draftId,
          {
            selector: "#cta",
            bbox: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      ]),
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    fireEvent.click(screen.getByTestId("pending-snap-dismiss"));
    const state = useViewerStore.getState();
    expect(state.draftIgnoreAreas[0]!.selector).toBeUndefined();
    expect(state.pendingSnaps.size).toBe(0);
  });

  test("renders selector indicator (and × clear button) when selected region has a selector", async () => {
    const draftId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
          selector: "#login",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    expect(screen.getByTestId("selector-row")).toBeDefined();
    expect(screen.getByTestId("selector-value").textContent).toBe("#login");
    expect(screen.queryByTestId("pending-snap-row")).toBeNull();
  });

  test("× clear on a selector indicator removes selector from a draft in place", async () => {
    const draftId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
          selector: "#clearme",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    fireEvent.click(screen.getByTestId("selector-clear"));
    expect(
      useViewerStore.getState().draftIgnoreAreas[0]!.selector,
    ).toBeUndefined();
  });

  test("× clear on a saved-region selector indicator sets a null override", async () => {
    const savedId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
          selector: "#hydrated",
        },
      ],
      selectedIgnoreId: savedId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    fireEvent.click(screen.getByTestId("selector-clear"));
    expect(useViewerStore.getState().selectorOverrides.get(savedId)).toBeNull();
    // Saved row itself untouched.
    expect(useViewerStore.getState().savedRunIgnoreAreas[0]!.selector).toBe(
      "#hydrated",
    );
  });

  test("handleSave payload carries selector from drafts and folds selectorOverrides on saved rows", () => {
    const savedId = crypto.randomUUID();
    const savedClearedId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 100,
          y: 100,
          width: 50,
          height: 50,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
          selector: "#kept",
        },
        {
          id: savedClearedId,
          x: 200,
          y: 200,
          width: 50,
          height: 50,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
          selector: "#was-anchored",
        },
      ],
      draftIgnoreAreas: [
        {
          id: draftId,
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
          selector: "#fresh-draft",
        },
      ],
      // Override the second saved row's selector with null = explicit clear.
      selectorOverrides: new Map([[savedClearedId, null]]),
      selectedIgnoreId: null,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("ignore-save-button"));
    expect(setIgnoreAreasMutate).toHaveBeenCalled();
    const payload = setIgnoreAreasMutate.mock.calls[0]![0] as {
      ignoreAreas: Array<{ x: number; selector?: string }>;
    };
    const keptSaved = payload.ignoreAreas.find((r) => r.x === 100);
    const clearedSaved = payload.ignoreAreas.find((r) => r.x === 200);
    const fresh = payload.ignoreAreas.find((r) => r.x === 10);
    expect(keptSaved!.selector).toBe("#kept");
    expect(clearedSaved!.selector).toBeUndefined();
    expect(fresh!.selector).toBe("#fresh-draft");
  });

  test("Save button enables when only a selectorOverride is pending (saved-region clear path)", () => {
    const savedId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewport: VP,
          paddingPx: 0,
          kind: "ignore",
          selector: "#x",
        },
      ],
      selectorOverrides: new Map([[savedId, null]]),
      selectedIgnoreId: null,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    const btn = screen.getByTestId("ignore-save-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});
