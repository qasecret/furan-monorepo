import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { SizeChip } from "../src/components/diff-viewer/SizeChip";

describe("SizeChip", () => {
  afterEach(() => cleanup());

  test("one neutral chip when baseline and candidate sizes match", () => {
    render(
      <SizeChip
        baseline={{ width: 1280, height: 720 }}
        candidate={{ width: 1280, height: 720 }}
      />,
    );
    expect(screen.getByTestId("diff-viewer-size-chip").textContent).toBe(
      "1280×720",
    );
    expect(screen.queryByTestId("diff-viewer-size-chip-mismatch")).toBeNull();
  });

  test("a mismatch chip whose text, arrow included, is -800 on the -100 chip (R18)", () => {
    render(
      <SizeChip
        baseline={{ width: 1280, height: 720 }}
        candidate={{ width: 1280, height: 900 }}
      />,
    );
    const chip = screen.getByTestId("diff-viewer-size-chip-mismatch");
    expect(chip.textContent).toBe("1280×720→1280×900");
    expect(chip.classList.contains("bg-amber-100")).toBe(true);
    expect(chip.classList.contains("text-amber-800")).toBe(true);
    const arrow = Array.from(chip.querySelectorAll("span")).find(
      (s) => s.textContent === "→",
    )!;
    expect(arrow.className).toBe("text-amber-800");
  });
});
