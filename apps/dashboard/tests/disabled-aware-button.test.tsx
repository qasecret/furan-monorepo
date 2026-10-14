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

import { Button } from "@/components/ui/button";
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

    // An unavailable button stays hoverable (to show its reason), so the
    // variant's hover colours must not make it look pressable. jsdom has no
    // Tailwind, so this pins the classes that do it: for each hover utility the
    // variant has, an `aria-disabled:hover:` one of the same property that
    // keeps the resting token colour.
    test.each(["default", "secondary", "destructive", "ghost"] as const)(
      "a %s button keeps its resting colours on hover while unavailable",
      (variant) => {
        const { container } = render(
          <Button variant={variant} type="button">
            x
          </Button>,
        );
        const hovers = (container.firstElementChild!.className.match(
          /(?:^|\s)hover:(bg|text)-\S+/g,
        ) ?? []) as string[];
        expect(hovers.length).toBeGreaterThan(0);
        cleanup();

        renderButton({ variant, disabled: true, reason: REASON });
        const classes = screen.getByTestId("act").className.split(/\s+/);
        for (const hover of hovers) {
          const property = hover.trim().split(":")[1]!.split("-")[0];
          const resting = classes.filter((c) =>
            c.startsWith(`aria-disabled:hover:${property}-`),
          );
          expect(resting.length, `${variant} ${hover}`).toBeGreaterThan(0);
        }
        // Tokens only: no palette colours, no arbitrary values.
        for (const c of classes.filter((c) =>
          c.startsWith("aria-disabled:hover:"),
        )) {
          expect(c).not.toMatch(
            /\b(zinc|gray|slate|neutral|stone)-\d|\[|#[0-9a-f]{3}/,
          );
        }
      },
    );

    test("a caller's own resting hover colours replace the variant's", () => {
      renderButton({
        variant: "ghost",
        disabled: true,
        reason: REASON,
        className:
          "hover:bg-edge aria-disabled:hover:bg-edge-strong aria-disabled:hover:text-fg-muted",
      });
      const classes = screen.getByTestId("act").className.split(/\s+/);
      expect(classes).toContain("aria-disabled:hover:text-fg-muted");
      expect(classes).not.toContain("aria-disabled:hover:text-fg-secondary");
      expect(classes).toContain("aria-disabled:hover:bg-edge-strong");
      expect(classes).not.toContain("aria-disabled:hover:bg-transparent");
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
