import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
// The region list has a suite of its own.
vi.mock("@/components/diff-viewer/RegionListPanel", () => ({
  RegionListPanel: () => <div data-testid="region-list-panel" />,
}));

import { createBackend, TrpcBackend, type Call } from "./trpc-backend";

import {
  IgnoreRegionListPanel,
  useIgnoreRegionsInView,
} from "@/components/diff-viewer/IgnoreRegionListPanel";
import { InfoRail } from "@/components/diff-viewer/InfoRail";
import { useRailState } from "@/components/diff-viewer/rail-state";
import { TestInfoSidebar } from "@/components/diff-viewer/TestInfoSidebar";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
} from "@/components/diff-viewer/viewer-prefs";

/**
 * A run's unsent comment (R25): kept in the viewer store by run id, so it
 * outlives its comment box, which unmounts when the rail holds the ignore-
 * region editor, changes tab or collapses. A successful save drops it, and
 * runs never share one.
 */

const RUN_A = "11111111-1111-1111-1111-111111111111";
const RUN_B = "22222222-2222-2222-2222-222222222222";

/** The server's saved comments, by run. */
let saved: Record<string, string | null>;
let backend = createBackend();

function answer(call: Call): Promise<unknown> {
  const runId = call.input.runId as string;
  if (call.path === "runs.getById") {
    return Promise.resolve({ id: runId, comment: saved[runId] ?? null });
  }
  if (call.path === "runs.setComment") {
    const comment = call.input.comment as string | null;
    saved[runId] = comment;
    return Promise.resolve({ runId, comment });
  }
  return Promise.resolve({ items: [], nextCursor: null });
}

const INFO = {
  test: "Pricing Page",
  stepLabel: "1/2 Monthly Plans",
  match: null,
  app: null,
  branch: null,
  os: null,
  browser: null,
  viewport: null,
  startedAt: null,
  duration: null,
  runBy: null,
  pixelDiffPercent: null,
  regions: [],
  vlmDescription: null,
  testVariationId: null,
  currentBaselineKey: null,
};

/** The rail as the viewer mounts it, for one run. */
function Rail({ runId }: { runId: string }) {
  const count = useIgnoreRegionsInView(null).length;
  return (
    <InfoRail
      editor={{ content: <IgnoreRegionListPanel viewport={null} />, count }}
    >
      <TestInfoSidebar {...INFO} runId={runId} />
    </InfoRail>
  );
}

function renderRail(runId = RUN_A) {
  const view = render(
    <TrpcBackend backend={backend}>
      <Rail key={runId} runId={runId} />
    </TrpcBackend>,
  );
  return {
    ...view,
    showRun: (next: string) =>
      view.rerender(
        <TrpcBackend backend={backend}>
          <Rail key={next} runId={next} />
        </TrpcBackend>,
      ),
  };
}

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

const box = () => screen.getByTestId("comment-textarea") as HTMLTextAreaElement;
/** The comment box once its run's saved comment has loaded. */
async function loadedBox(value: string): Promise<HTMLTextAreaElement> {
  await waitFor(() => expect(box().value).toBe(value));
  return box();
}
const type = (text: string) =>
  fireEvent.change(box(), { target: { value: text } });
const button = (name: string) => screen.getByRole("button", { name });
const drafts = () => useViewerStore.getState().commentDrafts;
const editor = (on: boolean) =>
  act(() => useViewerStore.getState().setIgnoreEditMode(on ? "run" : "off"));

beforeEach(() => {
  saved = { [RUN_A]: "Saved note", [RUN_B]: null };
  backend = createBackend();
  backend.answer = answer;
  setWindowWidth(1440);
  useViewerPrefs.setState({
    userId: null,
    prefs: { ...DEFAULT_VIEWER_PREFS, railTab: "comments" },
    previousMode: "side-by-side",
  });
  useRailState.setState({ visit: null, started: false, focus: null });
  useViewerStore.setState({
    commentPanelOpen: false,
    commentDrafts: {},
    ignoreEditMode: "off",
    draftIgnoreAreas: [],
  });
});
afterEach(() => {
  cleanup();
  setWindowWidth(1024);
});

describe("the comment draft survives its box (R25)", () => {
  test("entering and leaving the ignore-region editor", async () => {
    renderRail();
    await loadedBox("Saved note");
    type("The timestamp shifts");
    editor(true);
    expect(screen.queryByTestId("comment-textarea")).toBeNull();
    editor(false);
    expect(box().value).toBe("The timestamp shifts");
  });

  test("switching tabs", async () => {
    renderRail();
    await loadedBox("Saved note");
    type("The timestamp shifts");
    fireEvent.click(button("Info"));
    expect(screen.queryByTestId("comment-textarea")).toBeNull();
    fireEvent.click(button("Comments"));
    expect(box().value).toBe("The timestamp shifts");
  });

  test("collapsing and expanding the rail", async () => {
    renderRail();
    await loadedBox("Saved note");
    type("The timestamp shifts");
    fireEvent.click(button("Hide details"));
    expect(screen.queryByTestId("comment-textarea")).toBeNull();
    fireEvent.click(button("Show details"));
    expect(box().value).toBe("The timestamp shifts");
  });

  test("a successful save drops the draft; the box shows the saved comment from then on", async () => {
    renderRail();
    await loadedBox("Saved note");
    type("The timestamp shifts");
    expect(drafts()[RUN_A]).toBe("The timestamp shifts");
    fireEvent.click(screen.getByTestId("comment-save-button"));
    await waitFor(() => expect(drafts()[RUN_A]).toBeUndefined());
    expect(saved[RUN_A]).toBe("The timestamp shifts");
    expect(box().value).toBe("The timestamp shifts");
    // The next box is the saved comment's, not a draft's.
    fireEvent.click(button("Info"));
    fireEvent.click(button("Comments"));
    expect(box().value).toBe("The timestamp shifts");
  });

  test("between the save and the refetch, the box shows what was saved, never the old comment", async () => {
    renderRail();
    await loadedBox("Saved note");
    // The refetch after the save never answers.
    backend.answer = (call) =>
      call.path === "runs.getById" ? new Promise(() => {}) : answer(call);
    type("The timestamp shifts");
    fireEvent.click(screen.getByTestId("comment-save-button"));
    await waitFor(() => expect(drafts()[RUN_A]).toBeUndefined());
    expect(box().value).toBe("The timestamp shifts");
  });

  test("a failed save keeps the draft", async () => {
    backend.answer = (call) =>
      call.path === "runs.setComment"
        ? Promise.reject(new Error("Comment too long"))
        : answer(call);
    renderRail();
    await loadedBox("Saved note");
    type("The timestamp shifts");
    fireEvent.click(screen.getByTestId("comment-save-button"));
    await screen.findByTestId("comment-error");
    expect(drafts()[RUN_A]).toBe("The timestamp shifts");
  });

  test("typing back to the saved comment leaves no draft", async () => {
    renderRail();
    await loadedBox("Saved note");
    type("Saved note!");
    type("Saved note");
    expect(drafts()).toEqual({});
  });

  test("with no draft, the box follows the saved comment as it changes", async () => {
    const { rerender } = renderRail();
    await loadedBox("Saved note");
    saved[RUN_A] = "Edited elsewhere";
    // Something refetches the run (another reviewer's save, an event).
    rerender(
      <TrpcBackend backend={backend}>
        <Rail key="again" runId={RUN_A} />
      </TrpcBackend>,
    );
    await loadedBox("Edited elsewhere");
  });

  test("drafts for different runs don't mix", async () => {
    const { showRun } = renderRail(RUN_A);
    await loadedBox("Saved note");
    type("About run A");

    showRun(RUN_B);
    await loadedBox("");
    type("About run B");

    showRun(RUN_A);
    expect(box().value).toBe("About run A");
    expect(drafts()).toEqual({
      [RUN_A]: "About run A",
      [RUN_B]: "About run B",
    });
  });
});

describe("Mark as Bug's note (addCommentNote)", () => {
  const note = "Marked 'home' as a bug: ";

  test("goes into the run's draft when its box is empty, and says so", () => {
    expect(useViewerStore.getState().addCommentNote(RUN_A, note, null)).toBe(
      true,
    );
    expect(drafts()).toEqual({ [RUN_A]: note });
  });

  test("never clobbers a note: an unsent draft, or the saved comment", () => {
    useViewerStore.setState({ commentDrafts: { [RUN_A]: "Mine" } });
    expect(useViewerStore.getState().addCommentNote(RUN_A, note, null)).toBe(
      false,
    );
    expect(useViewerStore.getState().addCommentNote(RUN_B, note, "Saved")).toBe(
      false,
    );
    expect(drafts()).toEqual({ [RUN_A]: "Mine" });
    // A blank box is empty.
    expect(useViewerStore.getState().addCommentNote(RUN_B, note, "  ")).toBe(
      true,
    );
  });

  test("lands in a box already on screen", async () => {
    saved[RUN_A] = null;
    renderRail();
    await loadedBox("");
    act(() => {
      useViewerStore.getState().addCommentNote(RUN_A, note, null);
    });
    expect(box().value).toBe(note);
  });
});
