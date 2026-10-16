import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageTour } from "../src/components/tour/page-tour";
import {
  TourProvider,
  __resetTourDismissalsForTests,
  useTour,
  type TourStep,
} from "../src/components/tour/tour-context";
import { TourOverlay } from "../src/components/tour/tour-overlay";

/**
 * What the top bar's Help menu reads and calls: the page whose tour is
 * registered, and the replay.
 */
function TourControls() {
  const { state, relaunch } = useTour();
  return (
    <>
      <output data-testid="tour-page">{state.pageId ?? ""}</output>
      <output data-testid="tour-running">{String(state.active)}</output>
      <button type="button" data-testid="replay" onClick={relaunch}>
        Replay
      </button>
    </>
  );
}

/**
 * Renders the tour primitives inside a host that pins anchor elements
 * in the document so getBoundingClientRect resolves to a non-zero rect.
 */
function renderWithSteps(steps: TourStep[], pageId = "test-page") {
  return render(
    <TourProvider>
      <div id="anchor-a" style={{ width: 100, height: 40 }}>
        anchor-a
      </div>
      <div id="anchor-b" style={{ width: 100, height: 40 }}>
        anchor-b
      </div>
      <TourControls />
      <PageTour pageId={pageId} steps={steps} />
      <TourOverlay />
    </TourProvider>,
  );
}

const STEPS: TourStep[] = [
  { target: "#anchor-a", title: "First", content: "Step one" },
  { target: "#anchor-b", title: "Second", content: "Step two" },
];

describe("guided tour", () => {
  beforeEach(() => {
    __resetTourDismissalsForTests();
  });
  afterEach(() => {
    cleanup();
  });

  it("auto-starts on a fresh page and shows the first step", () => {
    renderWithSteps(STEPS);
    expect(screen.getByTestId("tour-popover")).toBeTruthy();
    expect(screen.getByText("Step one")).toBeTruthy();
    expect(screen.getByTestId("tour-progress").textContent).toBe("1 / 2");
  });

  it("Next advances through steps; Done on the last step dismisses", () => {
    renderWithSteps(STEPS);

    fireEvent.click(screen.getByTestId("tour-next-button"));
    expect(screen.getByText("Step two")).toBeTruthy();
    expect(screen.getByTestId("tour-progress").textContent).toBe("2 / 2");

    // Last step's button reads "Done" and dismisses the overlay.
    expect(screen.getByTestId("tour-next-button").textContent).toBe("Done");
    fireEvent.click(screen.getByTestId("tour-next-button"));
    expect(screen.queryByTestId("tour-popover")).toBeNull();
  });

  it("Back returns to the previous step", () => {
    renderWithSteps(STEPS);
    fireEvent.click(screen.getByTestId("tour-next-button"));
    expect(screen.getByText("Step two")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tour-prev-button"));
    expect(screen.getByText("Step one")).toBeTruthy();
  });

  it("Skip dismisses and writes the localStorage flag", () => {
    renderWithSteps(STEPS, "skip-test");
    fireEvent.click(screen.getByTestId("tour-skip-button"));
    expect(screen.queryByTestId("tour-popover")).toBeNull();
    expect(window.localStorage.getItem("furan:tour:dismissed:skip-test")).toBe(
      "1",
    );
  });

  it("does NOT auto-start when the page was previously dismissed", () => {
    window.localStorage.setItem("furan:tour:dismissed:returning", "1");
    renderWithSteps(STEPS, "returning");
    expect(screen.queryByTestId("tour-popover")).toBeNull();
  });

  it("ESC dismisses the active tour", () => {
    renderWithSteps(STEPS);
    expect(screen.getByTestId("tour-popover")).toBeTruthy();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(screen.queryByTestId("tour-popover")).toBeNull();
  });

  it("clicking the backdrop dismisses the tour", () => {
    renderWithSteps(STEPS);
    fireEvent.click(screen.getByTestId("tour-backdrop"));
    expect(screen.queryByTestId("tour-popover")).toBeNull();
  });

  it("first step has no Back button (no previous step to return to)", () => {
    renderWithSteps(STEPS);
    expect(screen.queryByTestId("tour-prev-button")).toBeNull();
  });

  it("renders nothing when steps array is empty", () => {
    renderWithSteps([], "empty");
    expect(screen.queryByTestId("tour-popover")).toBeNull();
    // The dismissal flag should NOT be set when there is nothing to start.
    expect(
      window.localStorage.getItem("furan:tour:dismissed:empty"),
    ).toBeNull();
  });

  it("renders nothing when the target selector matches no element", () => {
    const orphan: TourStep[] = [
      { target: "#does-not-exist", content: "phantom" },
    ];
    renderWithSteps(orphan, "orphan");
    // The state is active but computePosition returns null → no popover.
    expect(screen.queryByTestId("tour-popover")).toBeNull();
  });

  it("retries positioning when the target appears after first render (dynamic-import race)", async () => {
    // Reproduces the diff-viewer scenario: the page registers a tour
    // step before the dynamic chunk paints its target element. The
    // overlay must keep retrying until the target shows up.
    const dynamic: TourStep[] = [
      { target: "#late-anchor", title: "Dynamic", content: "Appears later" },
    ];
    render(
      <TourProvider>
        <PageTour pageId="dynamic-import-race" steps={dynamic} />
        <TourOverlay />
      </TourProvider>,
    );

    // Anchor does not exist yet — overlay starts polling.
    expect(screen.queryByTestId("tour-popover")).toBeNull();

    // Inject the target a moment later, mimicking a dynamic-import paint.
    setTimeout(() => {
      const el = document.createElement("div");
      el.id = "late-anchor";
      el.style.width = "100px";
      el.style.height = "40px";
      document.body.appendChild(el);
    }, 150);

    // Within the 2 s retry window the popover should now appear.
    await waitFor(
      () => expect(screen.queryByTestId("tour-popover")).toBeTruthy(),
      { timeout: 2500 },
    );

    // Cleanup the injected node so it does not leak across cases.
    document.getElementById("late-anchor")?.remove();
  });

  it("scrolls the target into view exactly once per step, not on every scroll event", () => {
    // The bug being fixed: previously scrollIntoView was called inside
    // computePosition, which the scroll listener re-invokes on every
    // scroll event. Smooth-scroll fired scroll events that re-fired
    // scrollIntoView, creating a feedback loop.
    const scrollSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollSpy,
    });

    renderWithSteps(STEPS);

    // First step shown — scrolled once.
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // Synthesize a scroll event; the listener should reposition the
    // popover but NOT re-scroll.
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // Advancing to the next step scrolls exactly one more time.
    fireEvent.click(screen.getByTestId("tour-next-button"));
    expect(scrollSpy).toHaveBeenCalledTimes(2);
  });

  describe("replay", () => {
    it("a page registers its tour even when it was dismissed before", () => {
      window.localStorage.setItem("furan:tour:dismissed:returning-user", "1");
      renderWithSteps(STEPS, "returning-user");

      // The tour did NOT auto-start (no popover) but the page DID register,
      // so Replay tour knows where to relaunch from.
      expect(screen.queryByTestId("tour-popover")).toBeNull();
      expect(screen.getByTestId("tour-page").textContent).toBe(
        "returning-user",
      );

      fireEvent.click(screen.getByTestId("replay"));
      expect(screen.getByTestId("tour-popover")).toBeTruthy();
    });

    it("a page with no tour registers nothing", () => {
      render(
        <TourProvider>
          <TourControls />
        </TourProvider>,
      );
      expect(screen.getByTestId("tour-page").textContent).toBe("");
      // Nothing to replay: relaunching is safe and shows nothing.
      fireEvent.click(screen.getByTestId("replay"));
      expect(screen.queryByTestId("tour-popover")).toBeNull();
    });

    it("replaying a dismissed tour starts from step 1", () => {
      renderWithSteps(STEPS, "relaunch-test");
      fireEvent.click(screen.getByTestId("tour-next-button"));
      fireEvent.click(screen.getByTestId("tour-skip-button"));
      expect(screen.queryByTestId("tour-popover")).toBeNull();

      fireEvent.click(screen.getByTestId("replay"));
      expect(screen.getByTestId("tour-popover")).toBeTruthy();
      // Re-launch resets to step 1, not whatever index the user was on
      // when they dismissed.
      expect(screen.getByTestId("tour-progress").textContent).toBe("1 / 2");
      expect(screen.getByText("Step one")).toBeTruthy();
    });

    it("re-launch clears the localStorage dismissal flag (next mount auto-starts)", () => {
      renderWithSteps(STEPS, "flag-clear");
      fireEvent.click(screen.getByTestId("tour-skip-button"));
      expect(
        window.localStorage.getItem("furan:tour:dismissed:flag-clear"),
      ).toBe("1");

      fireEvent.click(screen.getByTestId("replay"));
      // After relaunch, the dismissed flag is removed so the auto-start
      // path runs again on the next session.
      expect(
        window.localStorage.getItem("furan:tour:dismissed:flag-clear"),
      ).toBeNull();
    });
  });

  describe("a page's registration follows the page", () => {
    it("is cleared when the page unmounts", () => {
      const page = render(
        <TourProvider>
          <TourControls />
          <PageTour pageId="leaving" steps={STEPS} />
        </TourProvider>,
      );
      expect(screen.getByTestId("tour-page").textContent).toBe("leaving");

      // The page goes; the next one has no tour.
      page.rerender(
        <TourProvider>
          <TourControls />
        </TourProvider>,
      );
      expect(screen.getByTestId("tour-page").textContent).toBe("");
      // Replay has nothing to start, however it is asked.
      fireEvent.click(screen.getByTestId("replay"));
      expect(screen.queryByTestId("tour-popover")).toBeNull();
    });

    it("takes a running tour down with its page", () => {
      const page = render(
        <TourProvider>
          <div id="anchor-a" />
          <TourControls />
          <PageTour pageId="running" steps={STEPS} />
          <TourOverlay />
        </TourProvider>,
      );
      expect(screen.getByTestId("tour-popover")).toBeTruthy();
      expect(screen.getByTestId("tour-running").textContent).toBe("true");

      page.rerender(
        <TourProvider>
          <div id="anchor-a" />
          <TourControls />
          <TourOverlay />
        </TourProvider>,
      );
      expect(screen.queryByTestId("tour-popover")).toBeNull();
      expect(screen.getByTestId("tour-running").textContent).toBe("false");
    });

    it("is cleared only if it is still the unmounting page's own", () => {
      // The next page registered before the last one's cleanup ran.
      const both = (first: boolean, second: boolean) => (
        <TourProvider>
          <TourControls />
          {first && <PageTour pageId="first" steps={STEPS} />}
          {second && <PageTour pageId="second" steps={STEPS} />}
        </TourProvider>
      );
      const view = render(both(true, false));
      expect(screen.getByTestId("tour-page").textContent).toBe("first");
      view.rerender(both(true, true));
      expect(screen.getByTestId("tour-page").textContent).toBe("second");

      // The first goes away late: the second is still the page's tour.
      view.rerender(both(false, true));
      expect(screen.getByTestId("tour-page").textContent).toBe("second");
      // And when the second goes, nothing is left.
      view.rerender(both(false, false));
      expect(screen.getByTestId("tour-page").textContent).toBe("");
    });

    it("a page mounted under StrictMode keeps its tour", () => {
      // StrictMode runs a page's effects, cleans them up and runs them
      // again: the cleanup must not leave the page without its tour.
      render(
        <TourProvider>
          <div id="anchor-a" />
          <TourControls />
          <PageTour pageId="strict" steps={STEPS} />
          <TourOverlay />
        </TourProvider>,
        { reactStrictMode: true },
      );
      expect(screen.getByTestId("tour-page").textContent).toBe("strict");
      expect(screen.getByTestId("tour-popover")).toBeTruthy();
    });

    it("a new steps array for the same page does not restart its tour", () => {
      const tree = (steps: TourStep[]) => (
        <TourProvider>
          <div id="anchor-a" />
          <div id="anchor-b" />
          <TourControls />
          <PageTour pageId="stable" steps={steps} />
          <TourOverlay />
        </TourProvider>
      );
      const view = render(tree(STEPS));
      fireEvent.click(screen.getByTestId("tour-next-button"));
      expect(screen.getByTestId("tour-progress").textContent).toBe("2 / 2");

      // A parent that builds its steps inline gives a new array each render.
      view.rerender(tree([...STEPS]));
      expect(screen.getByTestId("tour-progress").textContent).toBe("2 / 2");
      expect(screen.getByTestId("tour-page").textContent).toBe("stable");
    });
  });
});
