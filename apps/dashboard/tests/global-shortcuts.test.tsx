import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { GlobalShortcuts } from "@/components/triage/global-shortcuts";

function fireKey(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("GlobalShortcuts", () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens shortcuts dialog on ?", () => {
    render(<GlobalShortcuts />);
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
    act(() => fireKey("?"));
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
  });

  it("navigates to /inbox on g i sequence", () => {
    render(<GlobalShortcuts />);
    act(() => {
      fireKey("g");
      fireKey("i");
    });
    expect(pushMock).toHaveBeenCalledWith("/inbox");
  });

  it("navigates to /projects on g p sequence", () => {
    render(<GlobalShortcuts />);
    act(() => {
      fireKey("g");
      fireKey("p");
    });
    expect(pushMock).toHaveBeenCalledWith("/projects");
  });

  it("clears prefix after the sequence window", () => {
    render(<GlobalShortcuts />);
    act(() => fireKey("g"));
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    act(() => fireKey("i"));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ignores g i typed into a form field", () => {
    render(
      <>
        <input data-testid="probe" />
        <GlobalShortcuts />
      </>,
    );
    const input = screen.getByTestId("probe");
    input.focus();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "g", bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "i", bubbles: true }),
      );
    });
    expect(pushMock).not.toHaveBeenCalled();
  });
});
