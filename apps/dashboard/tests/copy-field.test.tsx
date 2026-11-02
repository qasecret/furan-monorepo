import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import { CopyField } from "@/components/ui/copy-field";

const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    configurable: true,
  });
}

beforeEach(() => {
  toastMock.error.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (original) Object.defineProperty(navigator, "clipboard", original);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("CopyField", () => {
  test("shows the value and a button named for it", () => {
    render(<CopyField value="p1" label="project ID" data-testid="pid" />);
    expect(screen.getByTestId("pid").querySelector("code")?.textContent).toBe(
      "p1",
    );
    expect(
      screen.getByRole("button", { name: "Copy project ID" }).textContent,
    ).toContain("Copy");
  });

  test("copies, says so, and resets after 2 s", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<CopyField value="http://h:8080/api" label="API URL" />);
    const button = screen.getByRole("button", { name: "Copy API URL" });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith("http://h:8080/api");
    expect(button.textContent).toContain("Copied");
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("API URL copied");

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(button.textContent).toContain("Copy");
    expect(button.textContent).not.toContain("Copied");
  });

  test("a refused write toasts and keeps the value on screen", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("no")) });
    render(<CopyField value="p1" label="project ID" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy project ID" }));
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      "Copy failed — select the text manually",
    );
    expect(screen.getByText("p1")).toBeDefined();
  });

  test("plain http (no clipboard API) toasts instead of throwing", async () => {
    // An insecure context (a LAN IP over http) has no navigator.clipboard.
    setClipboard(undefined);
    render(<CopyField value="p1" label="project ID" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy project ID" }));
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      "Copy failed — select the text manually",
    );
  });
});
