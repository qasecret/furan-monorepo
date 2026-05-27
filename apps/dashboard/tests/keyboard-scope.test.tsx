import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { KeyboardScope } from "@/components/triage/keyboard-scope";

afterEach(cleanup);

describe("KeyboardScope", () => {
  test("calls registered handler on matching keydown", () => {
    const onApprove = vi.fn();
    render(
      <KeyboardScope bindings={{ a: onApprove }}>
        <button>focus target</button>
      </KeyboardScope>,
    );
    fireEvent.keyDown(document.body, { key: "a" });
    expect(onApprove).toHaveBeenCalledOnce();
  });

  test("does not fire when focus is inside an <input>", () => {
    const onApprove = vi.fn();
    const { getByRole } = render(
      <KeyboardScope bindings={{ a: onApprove }}>
        <input aria-label="text" />
      </KeyboardScope>,
    );
    const input = getByRole("textbox");
    input.focus();
    fireEvent.keyDown(input, { key: "a" });
    expect(onApprove).not.toHaveBeenCalled();
  });

  test("Esc passes through even from input", () => {
    const onEsc = vi.fn();
    const { getByRole } = render(
      <KeyboardScope bindings={{ Escape: onEsc }}>
        <input aria-label="text" />
      </KeyboardScope>,
    );
    const input = getByRole("textbox");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEsc).toHaveBeenCalledOnce();
  });
});
