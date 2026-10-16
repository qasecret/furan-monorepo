import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// The toolbar's mutations, inert: these tests read its hints only.
vi.mock("@/lib/trpc", () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    trpc: {
      useUtils: () => ({ runs: { getById: { invalidate: vi.fn() } } }),
      runs: {
        setIgnoreAreas: { useMutation: mutation },
        setTempIgnoreAreas: { useMutation: mutation },
        setDiffThresholdOverride: { useMutation: mutation },
      },
    },
  };
});

import type { DiffStepper } from "@/components/diff-viewer/useDiffStepper";
import { useDiffViewerShortcuts } from "@/components/diff-viewer/useDiffViewerShortcuts";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
} from "@/components/diff-viewer/viewer-prefs";
import { ViewerToolbar } from "@/components/diff-viewer/ViewerToolbar";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  useCommandRegistry,
} from "@/lib/commands/registry";

const stepper: DiffStepper = {
  index: 0,
  count: 3,
  next: vi.fn(),
  prev: vi.fn(),
};

/** The toolbar on the viewer's page: the viewer's commands registered. */
function Viewer({ registered = true }: { registered?: boolean }) {
  return (
    <CommandRoleProvider role="editor">
      {registered ? <Commands /> : null}
      <ViewerToolbar runId="r1" checkpointId="c1" stepper={stepper} />
    </CommandRoleProvider>
  );
}

function Commands() {
  useDiffViewerShortcuts({
    viewports: [],
    onNextDiff: stepper.next,
    onPrevDiff: stepper.prev,
  });
  return null;
}

/** Each control's title and aria-keyshortcuts, by test id. */
function hints(): Record<string, [string | null, string | null]> {
  const read = (el: HTMLElement): [string | null, string | null] => [
    el.getAttribute("title"),
    el.getAttribute("aria-keyshortcuts"),
  ];
  return {
    zoomOut: read(screen.getByTestId("zoom-out-button")),
    fit: read(screen.getByTestId("zoom-reset-button")),
    zoomIn: read(screen.getByTestId("zoom-in-button")),
    prevChange: read(screen.getByTestId("diff-prev")),
    nextChange: read(screen.getByTestId("diff-next")),
    diff: read(screen.getByRole("tab", { name: "Diff" })),
    highlight: read(screen.getByTestId("highlight-toggle")),
    editor: read(screen.getByTestId("edit-regions-toggle")),
  };
}

beforeEach(() => {
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  useViewerStore.setState({ ignoreEditMode: "off" });
  useViewerPrefs.setState({ prefs: DEFAULT_VIEWER_PREFS });
});
afterEach(() => cleanup());

describe("ViewerToolbar's key hints come from the command registry (R35)", () => {
  test("each control names the keys its command has", () => {
    render(<Viewer />);
    expect(hints()).toEqual({
      zoomOut: ["Zoom out (-)", "-"],
      fit: ["Fit to canvas (0)", "0"],
      zoomIn: ["Zoom in (=)", "= Plus"],
      prevChange: ["Previous change (P)", "P"],
      nextChange: ["Next change (N)", "N"],
      diff: ["Diff (D)", "D"],
      highlight: ["Highlight diffs (H)", "H"],
      editor: ["Edit regions (I)", "I"],
    });
    // Only the diff view's tab is D's.
    expect(
      screen.getByRole("tab", { name: "Side by side" }).getAttribute("title"),
    ).toBeNull();

    // The same key ends the editor.
    act(() => useViewerStore.setState({ ignoreEditMode: "variation" }));
    const done = screen.getByTestId("edit-regions-toggle");
    expect(done.getAttribute("title")).toBe("Done editing (I)");
    expect(done.getAttribute("aria-keyshortcuts")).toBe("I");
  });

  test("with single-key shortcuts off, no control promises a key", () => {
    render(<Viewer />);
    act(() => useSingleKeyStore.setState({ on: false }));
    // The icon-only buttons keep their names as a tooltip; the rest have
    // their names on screen.
    expect(hints()).toEqual({
      zoomOut: ["Zoom out", null],
      fit: ["Fit to canvas", null],
      zoomIn: ["Zoom in", null],
      prevChange: ["Previous change", null],
      nextChange: ["Next change", null],
      diff: [null, null],
      highlight: [null, null],
      editor: [null, null],
    });

    act(() => useSingleKeyStore.setState({ on: true }));
    expect(hints().zoomOut).toEqual(["Zoom out (-)", "-"]);
  });

  test("a key no command holds is never promised", () => {
    render(<Viewer registered={false} />);
    expect(hints()).toEqual({
      zoomOut: ["Zoom out", null],
      fit: ["Fit to canvas", null],
      zoomIn: ["Zoom in", null],
      prevChange: ["Previous change", null],
      nextChange: ["Next change", null],
      diff: [null, null],
      highlight: [null, null],
      editor: [null, null],
    });
  });
});
