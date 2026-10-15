/**
 * The key caps the `?` sheet and the palette share (`KeyCaps`, `KeyChoices`).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { KeyChoices } from "@/components/shortcuts/key-caps";

afterEach(() => cleanup());

/** The caps of each key, in order. */
function capsOf(root: HTMLElement): string[][] {
  return [...root.querySelectorAll(":scope > span > kbd")].map((key) =>
    [...key.querySelectorAll("kbd")].map((cap) => cap.textContent ?? ""),
  );
}

describe("KeyChoices", () => {
  test("alternative keys are split by a slash hidden from assistive technology", () => {
    const { container } = render(
      <KeyChoices keys={[{ tokens: ["R"] }, { tokens: ["X"] }]} />,
    );
    expect(capsOf(container)).toEqual([["R"], ["X"]]);
    const slash = [...container.querySelectorAll("span")].find(
      (s) => s.textContent === "/",
    );
    expect(slash?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).toBe("R/X");
  });

  test("a sequence reads G then I, with 'then' as plain text", () => {
    const { container } = render(
      <KeyChoices keys={[{ tokens: ["G", "then", "I"] }]} />,
    );
    expect(capsOf(container)).toEqual([["G", "I"]]);
    expect(container.textContent).toBe("G then I");
  });

  test("a key that is off is muted and carries the note; one that is on does neither", () => {
    const { container } = render(
      <KeyChoices
        keys={[{ tokens: ["A"], off: true }, { tokens: ["↓"] }]}
        offNote="(single-key shortcuts are off)"
      />,
    );
    const [off, on] = [...container.querySelectorAll("kbd kbd")];
    expect(off?.className).toContain("text-fg-muted");
    expect(on?.className).not.toContain("text-fg-muted");
    expect(on?.className).toContain("text-fg");
    expect(container.textContent).toBe("A(single-key shortcuts are off)/↓");
  });
});
