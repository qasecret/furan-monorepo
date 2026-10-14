import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DisabledAwareButton } from "@/components/ui/disabled-aware-button";

afterEach(cleanup);

function renderButton(
  over: Partial<Parameters<typeof DisabledAwareButton>[0]> = {},
) {
  const onClick = vi.fn();
  render(
    <DisabledAwareButton
      disabled={false}
      reason={null}
      testId="act"
      variant="secondary"
      onClick={onClick}
      {...over}
    >
      Do it
    </DisabledAwareButton>,
  );
  return { onClick };
}

describe("DisabledAwareButton", () => {
  test("an enabled button is a plain button that clicks", () => {
    const { onClick } = renderButton();
    expect(screen.queryByTestId("act-disabled-wrapper")).toBeNull();
    fireEvent.click(screen.getByTestId("act"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  test("a disabled button with no reason is a plain disabled button", () => {
    const { onClick } = renderButton({ disabled: true });
    expect(screen.queryByTestId("act-disabled-wrapper")).toBeNull();
    const button = screen.getByTestId("act") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("a disabled button with a reason is reachable, named and described", async () => {
    const { onClick } = renderButton({
      disabled: true,
      reason: "Clear the run override to review steps",
      label: "Approve home",
    });
    const wrapper = screen.getByTestId("act-disabled-wrapper");
    // In the tab order, even though the button itself is not.
    expect(wrapper.tabIndex).toBe(0);
    expect((screen.getByTestId("act") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(wrapper.getAttribute("role")).toBe("button");
    expect(wrapper.getAttribute("aria-disabled")).toBe("true");
    expect(wrapper.getAttribute("aria-label")).toBe("Approve home");
    // Described by the reason whether or not the tooltip is open.
    const reason = document.getElementById(
      wrapper.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe("Clear the run override to review steps");

    await act(async () => {
      wrapper.focus();
    });
    expect((await screen.findByTestId("act-disabled-reason")).textContent).toBe(
      "Clear the run override to review steps",
    );
    fireEvent.click(screen.getByTestId("act"));
    expect(onClick).not.toHaveBeenCalled();
  });

  test("without a label the wrapper is named by what it holds, not by the reason", () => {
    renderButton({ disabled: true, reason: "Because." });
    const wrapper = screen.getByTestId("act-disabled-wrapper");
    expect(wrapper.hasAttribute("aria-label")).toBe(false);
    expect(wrapper.textContent).toBe("Do it");
  });
});
