import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DisabledAwareButton } from "@/components/ui/disabled-aware-button";

afterEach(cleanup);

type Props = Parameters<typeof DisabledAwareButton>[0];

const base = (over: Partial<Props> = {}): Props => ({
  disabled: false,
  reason: null,
  testId: "act",
  variant: "secondary",
  onClick: vi.fn(),
  children: "Do it",
  ...over,
});

function renderButton(over: Partial<Props> = {}) {
  const props = base(over);
  const view = render(<DisabledAwareButton {...props} />);
  return {
    ...view,
    props,
    again: (next: Partial<Props>) =>
      view.rerender(<DisabledAwareButton {...props} {...next} />),
  };
}

/**
 * The accessible description: the text of every element `aria-describedby`
 * names, hidden ones included (which is what assistive technology reads).
 */
const descriptionOf = (el: Element): string =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();

const REASON = "Clear the run override to review steps";

describe("DisabledAwareButton", () => {
  test("an enabled button is a plain button that clicks", () => {
    const { props } = renderButton();
    const button = screen.getByTestId("act");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.click(button);
    expect(props.onClick).toHaveBeenCalledOnce();
  });

  test("keeps its title while it is enabled", () => {
    renderButton({ title: "Does the thing" });
    expect(screen.getByTestId("act").getAttribute("title")).toBe(
      "Does the thing",
    );
  });

  test("a disabled button with no reason is a plain, natively disabled button", () => {
    const { props } = renderButton({ disabled: true });
    const button = screen.getByTestId("act") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(button);
    expect(props.onClick).not.toHaveBeenCalled();
  });

  describe("disabled, with a reason", () => {
    test("is one control: a single button, no wrapper", () => {
      renderButton({ disabled: true, reason: REASON, label: "Approve home" });
      expect(
        screen.getAllByRole("button", { name: "Approve home" }),
      ).toHaveLength(1);
      expect(screen.getAllByRole("button")).toHaveLength(1);
      expect(screen.queryByTestId("act-disabled-wrapper")).toBeNull();
    });

    test("reports itself disabled to assistive technology, not to the browser", () => {
      renderButton({ disabled: true, reason: REASON, label: "Approve home" });
      const button = screen.getByRole("button", {
        name: "Approve home",
      }) as HTMLButtonElement;
      expect(button.getAttribute("aria-disabled")).toBe("true");
      // Natively disabled would take it out of the tab order.
      expect(button.disabled).toBe(false);
      expect(button.tabIndex).toBe(0);
    });

    test("is described by the reason, which is hidden text that is not read in place", () => {
      renderButton({ disabled: true, reason: REASON, label: "Approve home" });
      const button = screen.getByRole("button", { name: "Approve home" });
      expect(descriptionOf(button)).toBe(REASON);
      const node = document.getElementById(
        button.getAttribute("aria-describedby")!,
      )!;
      expect(node.hasAttribute("hidden")).toBe(true);
    });

    test("is named by what it holds when it has no label", () => {
      renderButton({ disabled: true, reason: REASON });
      expect(screen.getByRole("button", { name: "Do it" })).toBeDefined();
    });

    test("does nothing when clicked", () => {
      const { props } = renderButton({ disabled: true, reason: REASON });
      fireEvent.click(screen.getByTestId("act"));
      expect(props.onClick).not.toHaveBeenCalled();
    });

    test("does nothing when Enter or Space is pressed on it", async () => {
      const user = userEvent.setup();
      const { props } = renderButton({ disabled: true, reason: REASON });
      screen.getByTestId("act").focus();
      await user.keyboard("{Enter}");
      await user.keyboard(" ");
      expect(props.onClick).not.toHaveBeenCalled();
    });

    test("is reached with the keyboard, and shows its reason there", async () => {
      const user = userEvent.setup();
      renderButton({ disabled: true, reason: REASON });
      await act(async () => {
        await user.tab();
      });
      expect(document.activeElement).toBe(screen.getByTestId("act"));
      expect(
        (await screen.findByTestId("act-disabled-reason")).textContent,
      ).toBe(REASON);
    });

    test("drops its native title, which the tooltip replaces", () => {
      renderButton({ disabled: true, reason: REASON, title: "Does the thing" });
      expect(screen.getByTestId("act").hasAttribute("title")).toBe(false);
    });
  });

  test("keeps the very same button, and its focus, as it becomes disabled and enabled again", () => {
    const { again } = renderButton();
    const button = screen.getByTestId("act");
    button.focus();

    again({ disabled: true, reason: REASON });
    expect(screen.getByTestId("act")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");

    again({ disabled: false, reason: null });
    expect(screen.getByTestId("act")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });

  test("hands its ref to the button", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <DisabledAwareButton
        {...base({ disabled: true, reason: REASON })}
        ref={ref}
      />,
    );
    expect(ref.current).toBe(screen.getByTestId("act"));
  });
});
