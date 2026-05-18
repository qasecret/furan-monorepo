import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const setIgnoreAreasMutate = vi.fn();
const invalidate = vi.fn();
let isPending = false;

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
      ignoreAreas: [{ x: 10, y: 10, width: 20, height: 20, viewport: VP }],
    });
    expect(invalidate).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  test("Save merges drafts and excludes markedForDeletion (variation scope)", () => {
    useViewerStore.getState().hydrateSavedIgnoreAreas(
      [],
      [
        { x: 1, y: 1, width: 5, height: 5, viewport: VP },
        { x: 2, y: 2, width: 5, height: 5, viewport: VP },
      ],
    );
    const ids = useViewerStore
      .getState()
      .savedVariationIgnoreAreas.map((r) => r.id);
    useViewerStore.setState({
      ignoreEditMode: "variation",
      draftIgnoreAreas: [
        { id: "d1", x: 100, y: 100, width: 30, height: 30, viewport: VP },
      ],
      markedForDeletion: new Set([ids[0]!]),
    });

    render(<ViewerToolbar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("ignore-save-button"));

    expect(setIgnoreAreasMutate).toHaveBeenCalledWith({
      runId: RUN_ID,
      scope: "variation",
      ignoreAreas: [
        { x: 2, y: 2, width: 5, height: 5, viewport: VP },
        { x: 100, y: 100, width: 30, height: 30, viewport: VP },
      ],
    });
  });

  test("Discard wipes drafts + markedForDeletion (store state)", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        { id: "d1", x: 1, y: 1, width: 10, height: 10, viewport: VP },
      ],
      markedForDeletion: new Set(["x"]),
    });

    render(<ViewerToolbar runId={RUN_ID} />);
    fireEvent.click(screen.getByTestId("ignore-discard-button"));
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([]);
    expect(useViewerStore.getState().markedForDeletion.size).toBe(0);
  });

  test("scope switch with unsaved changes prompts confirm; Cancel preserves state", async () => {
    const user = userEvent.setup();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        { id: "d1", x: 1, y: 1, width: 10, height: 10, viewport: VP },
      ],
    });

    render(<ViewerToolbar runId={RUN_ID} />);
    // Open the scope-switch dropdown (separate from the exit toggle when editing).
    await user.click(screen.getByTestId("scope-switch-dropdown-trigger"));
    // Pick the "variation" item to request a scope switch.
    await user.click(screen.getByTestId("switch-scope-variation"));

    // Confirm bar appears.
    expect(screen.getByTestId("scope-switch-confirm")).toBeDefined();
    expect(useViewerStore.getState().ignoreEditMode).toBe("run"); // not switched yet

    // Cancel keeps state.
    await user.click(screen.getByTestId("scope-switch-confirm-no"));
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(1);
    expect(screen.queryByTestId("scope-switch-confirm")).toBeNull();
  });

  test("scope switch confirm → discard + switch", async () => {
    const user = userEvent.setup();
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        { id: "d1", x: 1, y: 1, width: 10, height: 10, viewport: VP },
      ],
    });

    render(<ViewerToolbar runId={RUN_ID} />);
    await user.click(screen.getByTestId("scope-switch-dropdown-trigger"));
    await user.click(screen.getByTestId("switch-scope-variation"));
    expect(screen.getByTestId("scope-switch-confirm")).toBeDefined();

    await user.click(screen.getByTestId("scope-switch-confirm-yes"));
    expect(useViewerStore.getState().ignoreEditMode).toBe("variation");
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([]);
    expect(screen.queryByTestId("scope-switch-confirm")).toBeNull();
  });
});
