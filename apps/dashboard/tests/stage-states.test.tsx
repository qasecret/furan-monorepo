import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The renderers are only asked what they need here, never mounted.
vi.mock("pixi.js", () => ({}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// The toolbar's mutations, inert: these tests read its mode control only.
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

import type {
  ImageRole,
  ImageSetState,
  LoadedImage,
} from "@/components/diff-viewer/image-set";
import {
  FALLBACK_MAX_TEXTURE_SIZE,
  readMaxTextureSize,
  stageStates,
  StageStates,
  type StageState,
} from "@/components/diff-viewer/StageStates";
import type { Size } from "@/components/diff-viewer/viewer-geometry";
import {
  DEFAULT_VIEWER_PREFS,
  modeAvailable,
  useViewerPrefs,
  VIEWER_MODES,
  type ViewerMode,
} from "@/components/diff-viewer/viewer-prefs";
import { ViewerToolbar } from "@/components/diff-viewer/ViewerToolbar";

const image = (role: ImageRole, w: number, h: number): LoadedImage => ({
  key: `k-${role}`,
  bitmap: { width: w, height: h } as ImageBitmap,
  size: { w, h },
});

function set(
  images: ImageSetState["images"],
  failed: ImageSetState["failed"] = {},
  status: ImageSetState["status"] = "ready",
): ImageSetState {
  return { status, images, failed, retry: () => {} };
}

/** The inputs of an ordinary step with a baseline, overridden per test. */
function input(
  over: Partial<Parameters<typeof stageStates>[0]> = {},
): Parameters<typeof stageStates>[0] {
  const baseline = image("baseline", 100, 200);
  const current = image("current", 100, 200);
  return {
    mode: "side-by-side",
    set: set({ baseline, current, diff: image("diff", 100, 200) }),
    hasBaseline: true,
    legacyMissing: false,
    stepHasDiff: true,
    sizes: { baseline: baseline.size, current: current.size },
    maxTextureSize: 16384,
    ...over,
  };
}

/** Diff mode, both screenshots in at these sizes, and no diff image. */
function diffWithoutImage(
  b: Size,
  c: Size,
  over: Partial<Parameters<typeof stageStates>[0]> = {},
) {
  return input({
    mode: "diff",
    set: set({
      baseline: image("baseline", b.w, b.h),
      current: image("current", c.w, c.h),
    }),
    sizes: { baseline: b, current: c },
    ...over,
  });
}

const kinds = (states: StageState[]) => states.map((s) => s.kind);

afterEach(() => cleanup());

describe("modeAvailable (R2)", () => {
  test("with a baseline every mode is available", () => {
    for (const mode of VIEWER_MODES)
      expect(modeAvailable(mode, true)).toBe(true);
  });

  test("without one, only side by side", () => {
    const available = VIEWER_MODES.filter((m) => modeAvailable(m, false));
    expect(available).toEqual(["side-by-side"]);
  });
});

describe("stageStates", () => {
  test("an ordinary step, all in, says nothing", () => {
    for (const mode of VIEWER_MODES) {
      expect(stageStates(input({ mode }))).toEqual([]);
    }
  });

  describe("Diff", () => {
    test("sizes that differ give the size mismatch, with both sizes", () => {
      const states = stageStates(
        diffWithoutImage({ w: 100, h: 200 }, { w: 100, h: 300 }),
      );
      expect(states).toEqual([
        {
          kind: "diff-size-mismatch",
          baseline: { w: 100, h: 200 },
          current: { w: 100, h: 300 },
        },
      ]);
    });

    test("the same sizes and no diff image: no changes, when the step has no diff, even on a legacy multi-step run (R4)", () => {
      const same = { w: 100, h: 200 };
      expect(
        stageStates(diffWithoutImage(same, same, { stepHasDiff: false })),
      ).toEqual([{ kind: "diff-no-changes" }]);
      // A fresh identical step of a multi-step run has no key either.
      expect(
        stageStates(
          diffWithoutImage(same, same, {
            stepHasDiff: false,
            legacyMissing: true,
          }),
        ),
      ).toEqual([{ kind: "diff-no-changes" }]);
    });

    test("the same sizes, no diff image, a diff on the step and a legacy run: no diff image was kept (R4)", () => {
      const same = { w: 100, h: 200 };
      expect(
        stageStates(
          diffWithoutImage(same, same, {
            stepHasDiff: true,
            legacyMissing: true,
          }),
        ),
      ).toEqual([{ kind: "diff-legacy-missing" }]);
      // A diff on a run of one step whose image is simply not there: no claim.
      expect(
        stageStates(
          diffWithoutImage(same, same, {
            stepHasDiff: true,
            legacyMissing: false,
          }),
        ),
      ).toEqual([]);
    });

    test("a diff image that is still loading is not taken for one that was never kept", () => {
      const same = { w: 100, h: 200 };
      const states = stageStates(
        diffWithoutImage(same, same, {
          stepHasDiff: false,
          set: set(
            {
              baseline: image("baseline", 100, 200),
              current: image("current", 100, 200),
            },
            {},
            "loading",
          ),
        }),
      );
      expect(kinds(states)).toEqual(["loading"]);
    });

    test("other modes say nothing about the diff image or the sizes", () => {
      for (const mode of ["side-by-side", "overlay"] as const) {
        expect(
          stageStates(
            diffWithoutImage({ w: 100, h: 200 }, { w: 100, h: 300 }, { mode }),
          ),
        ).toEqual([]);
        expect(
          stageStates(
            diffWithoutImage(
              { w: 100, h: 200 },
              { w: 100, h: 200 },
              {
                mode,
                stepHasDiff: false,
              },
            ),
          ),
        ).toEqual([]);
      }
    });

    test("a failed diff image and a size mismatch both apply", () => {
      const states = stageStates(
        diffWithoutImage(
          { w: 100, h: 200 },
          { w: 100, h: 300 },
          {
            set: set(
              {
                baseline: image("baseline", 100, 200),
                current: image("current", 100, 300),
              },
              { diff: true },
            ),
          },
        ),
      );
      expect(kinds(states)).toEqual(["failed", "diff-size-mismatch"]);
      expect(states[0]).toEqual({ kind: "failed", roles: ["diff"] });
    });
  });

  describe("failures", () => {
    test("a failed baseline", () => {
      const states = stageStates(
        input({
          set: set({ current: image("current", 100, 200) }, { baseline: true }),
          sizes: { current: { w: 100, h: 200 } },
        }),
      );
      expect(states).toEqual([{ kind: "failed", roles: ["baseline"] }]);
    });

    test("only the images the mode draws: a failed diff image is not side by side's", () => {
      const failedDiff = set(
        {
          baseline: image("baseline", 100, 200),
          current: image("current", 100, 200),
        },
        { diff: true },
      );
      expect(stageStates(input({ set: failedDiff }))).toEqual([]);
      expect(stageStates(input({ mode: "overlay", set: failedDiff }))).toEqual(
        [],
      );
      expect(stageStates(input({ mode: "diff", set: failedDiff }))).toEqual([
        { kind: "failed", roles: ["diff"] },
      ]);
    });

    test("every failed image the mode needs, in one state", () => {
      const states = stageStates(
        input({
          mode: "diff",
          set: set({}, { baseline: true, current: true, diff: true }),
          sizes: {},
        }),
      );
      expect(states).toEqual([
        { kind: "failed", roles: ["baseline", "current", "diff"] },
      ]);
    });
  });

  describe("loading", () => {
    test("while an image the mode needs is on its way", () => {
      const loadingBaseline = set(
        { current: image("current", 100, 200) },
        {},
        "loading",
      );
      for (const mode of VIEWER_MODES) {
        expect(
          kinds(stageStates(input({ mode, set: loadingBaseline }))),
        ).toEqual(["loading"]);
      }
    });

    test("not while only an image the mode doesn't draw is", () => {
      const loadingDiff = set(
        {
          baseline: image("baseline", 100, 200),
          current: image("current", 100, 200),
        },
        {},
        "loading",
      );
      expect(stageStates(input({ set: loadingDiff }))).toEqual([]);
      expect(
        kinds(stageStates(input({ mode: "diff", set: loadingDiff }))),
      ).toEqual(["loading"]);
    });
  });

  test("no baseline: said in every mode, and no mode's diff states", () => {
    for (const mode of VIEWER_MODES) {
      const states = stageStates(
        input({
          mode,
          hasBaseline: false,
          stepHasDiff: false,
          set: set({ current: image("current", 100, 200) }),
          sizes: { current: { w: 100, h: 200 } },
        }),
      );
      expect(states).toEqual([{ kind: "no-baseline" }]);
    }
  });

  test("too large: a screenshot past the texture limit (Review Focus 1)", () => {
    const tall = { w: 1440, h: 20000 };
    const states = stageStates(
      input({
        set: set({
          baseline: image("baseline", 1440, 900),
          current: image("current", 1440, 20000),
        }),
        sizes: { baseline: { w: 1440, h: 900 }, current: tall },
        maxTextureSize: 16384,
      }),
    );
    expect(states).toEqual([{ kind: "too-large", size: tall, max: 16384 }]);
  });

  test("too large: a baseline past the limit too, and nothing at the limit", () => {
    const wide = { w: 17000, h: 900 };
    expect(
      stageStates(
        input({
          sizes: { baseline: wide, current: { w: 1440, h: 900 } },
          maxTextureSize: 16384,
        }),
      ),
    ).toEqual([{ kind: "too-large", size: wide, max: 16384 }]);
    expect(
      stageStates(
        input({
          sizes: {
            baseline: { w: 16384, h: 16384 },
            current: { w: 16384, h: 16384 },
          },
          maxTextureSize: 16384,
        }),
      ),
    ).toEqual([]);
  });
});

describe("readMaxTextureSize", () => {
  const MAX_TEXTURE_SIZE = 0x0d33;

  test("asks the renderer's GL context", () => {
    const getParameter = vi.fn((p: number) =>
      p === MAX_TEXTURE_SIZE ? 16384 : 0,
    );
    expect(readMaxTextureSize({ gl: { MAX_TEXTURE_SIZE, getParameter } })).toBe(
      16384,
    );
    expect(getParameter).toHaveBeenCalledWith(MAX_TEXTURE_SIZE);
  });

  test("falls back to 8192 with no GL context, an answer that is no size, or a throw", () => {
    expect(FALLBACK_MAX_TEXTURE_SIZE).toBe(8192);
    expect(readMaxTextureSize(undefined)).toBe(8192);
    expect(readMaxTextureSize({})).toBe(8192);
    expect(
      readMaxTextureSize({
        gl: { MAX_TEXTURE_SIZE, getParameter: () => null },
      }),
    ).toBe(8192);
    expect(
      readMaxTextureSize({
        gl: {
          MAX_TEXTURE_SIZE,
          getParameter: () => {
            throw new Error("context lost");
          },
        },
      }),
    ).toBe(8192);
  });
});

describe("StageStates: the copy (spec §8)", () => {
  test("a failed image, with Retry for it", () => {
    const onRetry = vi.fn();
    render(
      <StageStates
        states={[{ kind: "failed", roles: ["baseline"] }]}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Couldn't load the baseline.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith("baseline");
  });

  test("each failed image has its own message and its own Retry", () => {
    const onRetry = vi.fn();
    render(
      <StageStates
        states={[{ kind: "failed", roles: ["current", "diff"] }]}
        onRetry={onRetry}
      />,
    );
    const current = screen.getByText("Couldn't load the current screenshot.");
    const diff = screen.getByText("Couldn't load the diff image.");
    const retries = screen.getAllByRole("button", { name: "Retry" });
    expect(retries).toHaveLength(2);
    // Each Retry is described by its own message.
    expect(retries.map((b) => b.getAttribute("aria-describedby"))).toEqual([
      current.id,
      diff.id,
    ]);
    fireEvent.click(retries[1]!);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith("diff");
  });

  test.each<[StageState, string]>([
    [
      { kind: "no-baseline" },
      "No baseline yet. Approve this step to make it the baseline.",
    ],
    [
      {
        kind: "diff-size-mismatch",
        baseline: { w: 100, h: 200 },
        current: { w: 100, h: 300 },
      },
      "The screenshots are different sizes (100×200 and 100×300), so there's no pixel diff. Compare them with Side by side, Swipe or Flicker.",
    ],
    [
      { kind: "diff-no-changes" },
      "No pixel changes between the baseline and the current screenshot.",
    ],
    [{ kind: "diff-legacy-missing" }, "No diff image was kept for this step."],
    [
      { kind: "too-large", size: { w: 1440, h: 20000 }, max: 16384 },
      "This screenshot is too large to draw on this device (1440×20000; the limit is 16384 px).",
    ],
  ])("%o reads its sentence", (state, copy) => {
    render(<StageStates states={[state]} onRetry={() => {}} />);
    expect(screen.getByText(copy)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("several states show together", () => {
    render(
      <StageStates
        states={[
          { kind: "failed", roles: ["diff"] },
          {
            kind: "diff-size-mismatch",
            baseline: { w: 1, h: 2 },
            current: { w: 1, h: 3 },
          },
        ]}
        onRetry={() => {}}
      />,
    );
    const box = screen.getByTestId("stage-states");
    expect(
      within(box).getByText("Couldn't load the diff image."),
    ).toBeDefined();
    expect(
      within(box).getByText(/different sizes \(1×2 and 1×3\)/),
    ).toBeDefined();
  });

  test("loading has no message (the canvas skeleton shows it), and nothing renders for no state", () => {
    const loading = render(
      <StageStates states={[{ kind: "loading" }]} onRetry={() => {}} />,
    );
    expect(loading.container.innerHTML).toBe("");
    loading.unmount();
    const none = render(<StageStates states={[]} onRetry={() => {}} />);
    expect(none.container.innerHTML).toBe("");
  });
});

describe("the toolbar without a baseline", () => {
  beforeEach(() => {
    useViewerPrefs.setState({
      userId: null,
      prefs: DEFAULT_VIEWER_PREFS,
      previousMode: "side-by-side",
    });
  });

  const modeButtons = () =>
    screen
      .getAllByRole("tab")
      .filter((t) => t.hasAttribute("data-mode")) as HTMLButtonElement[];

  test("every mode but side by side is aria-disabled, titled Needs a baseline, and does nothing", () => {
    render(<ViewerToolbar runId="r1" checkpointId="c1" hasBaseline={false} />);
    const buttons = modeButtons();
    expect(buttons.length).toBeGreaterThan(1);
    for (const b of buttons) {
      const mode = b.dataset.mode as ViewerMode;
      if (mode === "side-by-side") {
        expect(b.hasAttribute("aria-disabled")).toBe(false);
        expect(b.getAttribute("title")).not.toBe("Needs a baseline");
      } else {
        expect(b.getAttribute("aria-disabled")).toBe("true");
        expect(b.getAttribute("title")).toBe("Needs a baseline");
        fireEvent.click(b);
        expect(useViewerPrefs.getState().prefs.mode).toBe("side-by-side");
      }
    }
  });

  test("a stored mode that needs a baseline shows side by side as the selected one, and is kept", () => {
    useViewerPrefs.setState((s) => ({ prefs: { ...s.prefs, mode: "diff" } }));
    render(<ViewerToolbar runId="r1" checkpointId="c1" hasBaseline={false} />);
    const selected = modeButtons().filter(
      (b) => b.getAttribute("aria-selected") === "true",
    );
    expect(selected.map((b) => b.dataset.mode)).toEqual(["side-by-side"]);
    expect(useViewerPrefs.getState().prefs.mode).toBe("diff");
  });

  test("with a baseline, no mode is disabled", () => {
    render(<ViewerToolbar runId="r1" checkpointId="c1" hasBaseline />);
    for (const b of modeButtons()) {
      expect(b.hasAttribute("aria-disabled")).toBe(false);
    }
    fireEvent.click(modeButtons().find((b) => b.dataset.mode === "diff")!);
    expect(useViewerPrefs.getState().prefs.mode).toBe("diff");
  });
});
