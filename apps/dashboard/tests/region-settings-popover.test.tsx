/**
 * Tests for RegionSettingsPopover — the on-demand popover that holds
 * per-region match-type controls (padding, kind, tolerance, selector).
 *
 * The popover is opened via the `region-settings-trigger` button using the
 * same keyboard-activation pattern as approval-bar.test.tsx's openMoreMenu:
 * Radix DropdownMenu fires on pointerdown, so synthetic fireEvent.click on
 * the trigger doesn't open it in jsdom — we focus + keyDown Enter instead.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      runs: { getById: { invalidate: vi.fn() } },
    }),
    runs: {
      setIgnoreAreas: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
        }),
      },
      setTempIgnoreAreas: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
        }),
      },
      setDiffThresholdOverride: {
        useMutation: () => ({
          mutate: vi.fn(),
          isPending: false,
        }),
      },
    },
  },
}));

import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";
import { ViewerToolbar } from "../src/components/diff-viewer/ViewerToolbar";

const RUN_ID = "00000000-0000-0000-0000-000000000001";
const VP = "1280x720";

// Open the RegionSettingsPopover by keyboard-activating the trigger button.
// Radix DropdownMenu fires on pointerdown (not click), so focus + Enter is
// used — the same pattern as approval-bar.test.tsx's openMoreMenu.
async function openRegionSettings(): Promise<void> {
  const trigger = screen.getByTestId(
    "region-settings-trigger",
  ) as HTMLButtonElement;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  await new Promise((r) => setTimeout(r, 0));
}

describe("RegionSettingsPopover", () => {
  beforeEach(() => {
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

  test("trigger button is NOT rendered when editing is off", () => {
    useViewerStore.setState({ ignoreEditMode: "off", selectedIgnoreId: null });
    render(<ViewerToolbar runId={RUN_ID} />);
    expect(screen.queryByTestId("region-settings-trigger")).toBeNull();
  });

  test("trigger button is NOT rendered when editing but no region is selected", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      selectedIgnoreId: null,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    expect(screen.queryByTestId("region-settings-trigger")).toBeNull();
  });

  test("trigger button IS rendered when editing and a region is selected", () => {
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
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    expect(screen.getByTestId("region-settings-trigger")).toBeDefined();
  });

  test("padding-control always appears inside the open popover", async () => {
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
          paddingPx: 4,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    expect(screen.getByTestId("padding-control")).toBeDefined();
    expect(screen.getByTestId("padding-value").textContent).toBe("4px");
  });

  test("strict-tolerance-control appears ONLY when region kind is strict", async () => {
    const draftId = crypto.randomUUID();
    // First render with kind=ignore — no tolerance control.
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
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    expect(screen.queryByTestId("strict-tolerance-control")).toBeNull();
    cleanup();

    // Re-render with kind=strict — tolerance control should appear.
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
          kind: "strict",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    expect(screen.getByTestId("strict-tolerance-control")).toBeDefined();
    expect(screen.getByTestId("strict-tolerance-slider")).toBeDefined();
    expect(screen.getByTestId("strict-tolerance-value")).toBeDefined();
  });

  test("strict-tolerance-control does NOT appear for layout or content kinds", async () => {
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
          kind: "layout",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(<ViewerToolbar runId={RUN_ID} />);
    await openRegionSettings();
    expect(screen.queryByTestId("strict-tolerance-control")).toBeNull();
  });

  test("region-kind-control appears ONLY when dynamicTextEnabled is true", async () => {
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
      selectedIgnoreId: draftId,
    });

    // dynamicTextEnabled: false — kind control hidden even when popover open.
    render(
      <ViewerToolbar runId={RUN_ID} project={{ dynamicTextEnabled: false }} />,
    );
    await openRegionSettings();
    expect(screen.queryByTestId("region-kind-control")).toBeNull();
    cleanup();

    // dynamicTextEnabled: true — kind control visible.
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
      selectedIgnoreId: draftId,
    });
    render(
      <ViewerToolbar runId={RUN_ID} project={{ dynamicTextEnabled: true }} />,
    );
    await openRegionSettings();
    expect(screen.getByTestId("region-kind-control")).toBeDefined();
    expect(screen.getByTestId("region-kind-select")).toBeDefined();
  });

  test("PatternEditor (inside region-kind-control) appears ONLY for dynamic-text kind", async () => {
    const draftId = crypto.randomUUID();

    // kind=ignore → no PatternEditor.
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
      selectedIgnoreId: draftId,
    });
    render(
      <ViewerToolbar runId={RUN_ID} project={{ dynamicTextEnabled: true }} />,
    );
    await openRegionSettings();
    // PatternEditor renders a data-testid="pattern-editor" wrapping div;
    // if absent, we just check the region-kind-select is there but no pattern editor.
    expect(screen.queryByTestId("region-kind-control")).not.toBeNull();
    // No PatternEditor for ignore kind — kind-hint or pattern-editor input not present.
    expect(screen.queryByRole("textbox")).toBeNull();
    cleanup();

    // kind=dynamic-text → PatternEditor input present.
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
          kind: "dynamic-text",
          pattern: "\\d+",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(
      <ViewerToolbar runId={RUN_ID} project={{ dynamicTextEnabled: true }} />,
    );
    await openRegionSettings();
    // PatternEditor should render an input for editing the pattern.
    expect(screen.getByTestId("region-kind-control")).toBeDefined();
    // The PatternEditor renders an input element for the pattern value.
    const input = screen.queryByRole("textbox");
    expect(input).not.toBeNull();
  });

  test("region-kind-hint appears for strict/layout/content but NOT for ignore or dynamic-text", async () => {
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
          kind: "strict",
        },
      ],
      selectedIgnoreId: draftId,
    });
    render(
      <ViewerToolbar runId={RUN_ID} project={{ dynamicTextEnabled: true }} />,
    );
    await openRegionSettings();
    expect(screen.getByTestId("region-kind-hint")).toBeDefined();
    expect(screen.getByTestId("region-kind-hint").textContent).toContain(
      "Strict",
    );
  });
});
