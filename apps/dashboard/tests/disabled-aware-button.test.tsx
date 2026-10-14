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

import { Button, type ButtonProps } from "@/components/ui/button";
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
    // Tailwind, so this pins the classes that do it: exactly the
    // `aria-disabled:hover:` utilities below for each variant, each of which
    // restates what that variant looks like AT REST (a value Button itself
    // carries), and one for every hover property the variant changes.
    const RESTING_ON_HOVER = {
      default: ["bg-brand"],
      glow: ["bg-brand", "shadow-[0_8px_30px_-10px_rgba(168,255,83,0.7)]"],
      secondary: ["bg-raised", "text-fg-secondary"],
      destructive: ["bg-status-failed/10"],
      ghost: ["bg-transparent", "text-fg-secondary"],
    } as const satisfies Record<
      NonNullable<ButtonProps["variant"]>,
      readonly string[]
    >;

    test.each(
      Object.keys(RESTING_ON_HOVER) as Array<keyof typeof RESTING_ON_HOVER>,
    )(
      "a %s button keeps its resting colours on hover while unavailable",
      (variant) => {
        // What Button itself puts on this variant: its resting and hover classes.
        const { container } = render(
          <Button variant={variant} type="button">
            x
          </Button>,
        );
        const plain = container.firstElementChild!.className.split(/\s+/);
        cleanup();
        const hovers = plain.filter((c) => /^hover:(bg|text|shadow)-/.test(c));
        expect(hovers.length).toBeGreaterThan(0);

        renderButton({ variant, disabled: true, reason: REASON });
        const classes = screen.getByTestId("act").className.split(/\s+/);
        const counterparts = classes.filter((c) =>
          c.startsWith("aria-disabled:hover:"),
        );

        // Exactly these, with exactly these values.
        expect([...counterparts].sort()).toEqual(
          RESTING_ON_HOVER[variant]
            .map((v) => `aria-disabled:hover:${v}`)
            .sort(),
        );
        // Each value is the variant's own resting look. A ghost button has no
        // resting background, so it rests transparent.
        for (const resting of RESTING_ON_HOVER[variant]) {
          if (variant === "ghost" && resting === "bg-transparent") {
            expect(plain.some((c) => /^bg-/.test(c))).toBe(false);
          } else {
            expect(plain, `${variant} rests as ${resting}`).toContain(resting);
          }
        }
        // And every property a hover changes is restated.
        for (const hover of hovers) {
          const property = hover.slice("hover:".length).split("-")[0];
          expect(
            counterparts.some((c) =>
              c.startsWith(`aria-disabled:hover:${property}-`),
            ),
            `${variant} ${hover}`,
          ).toBe(true);
        }
        // Tokens only: no palette colours or raw hex. (The glow's own shadow
        // literal is the one arbitrary value, and is Button's.)
        for (const c of counterparts) {
          expect(c).not.toMatch(
            /\b(zinc|gray|slate|neutral|stone)-\d|#[0-9a-f]{3}/,
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
