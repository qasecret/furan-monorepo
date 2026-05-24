import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PageTour } from "../src/components/tour/page-tour";
import {
  TourProvider,
  __resetTourDismissalsForTests,
  type TourStep,
} from "../src/components/tour/tour-context";
import { TourOverlay } from "../src/components/tour/tour-overlay";

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
});
