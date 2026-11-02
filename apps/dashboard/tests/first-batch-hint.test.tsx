import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { FirstBatchHint } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/first-batch-hint";

afterEach(() => {
  cleanup();
});

const BEFORE =
  "Every test in this batch is new, so there's nothing to compare with yet. Check the screenshots, then Approve pending to save them as baselines.";
const AFTER =
  "Baselines saved. Run your tests again: the next batch is compared with these.";

type Counts = {
  id: string;
  runCount: number;
  newCount: number;
  passedCount: number;
};
const b = (
  id: string,
  runCount: number,
  newCount: number,
  passedCount: number,
): Counts => ({ id, runCount, newCount, passedCount });

const hint = () => screen.queryByTestId("first-batch-hint");

describe("FirstBatchHint", () => {
  test("an all-New batch says why there's nothing to compare", () => {
    render(<FirstBatchHint build={b("b1", 3, 3, 3)} />);
    expect(hint()?.getAttribute("role")).toBe("status");
    expect(hint()?.textContent).toContain(BEFORE);
    expect(
      screen
        .getByRole("link", { name: "About baselines (opens in a new tab)" })
        .getAttribute("href"),
    ).toBe("/docs/getting-started/first-baseline");
  });

  test("a partial approval keeps the first hint", () => {
    const r = render(<FirstBatchHint build={b("b1", 3, 3, 3)} />);
    r.rerender(<FirstBatchHint build={b("b1", 3, 1, 3)} />);
    expect(hint()?.textContent).toContain(BEFORE);
  });

  test("after approving every step it says to run again", () => {
    const r = render(<FirstBatchHint build={b("b1", 3, 3, 3)} />);
    r.rerender(<FirstBatchHint build={b("b1", 3, 0, 3)} />);
    expect(hint()?.textContent).toContain(AFTER);
    expect(
      screen
        .getByRole("link", {
          name: "Reviewing your first diff (opens in a new tab)",
        })
        .getAttribute("href"),
    ).toBe("/docs/getting-started/first-diff");
  });

  test("a rejected step means no baselines-saved hint", () => {
    const r = render(<FirstBatchHint build={b("b1", 3, 3, 3)} />);
    r.rerender(<FirstBatchHint build={b("b1", 3, 0, 2)} />);
    expect(hint()).toBeNull();
  });

  test("a mixed batch shows nothing", () => {
    render(<FirstBatchHint build={b("b2", 3, 1, 3)} />);
    expect(hint()).toBeNull();
  });

  test("a batch already approved before the visit shows nothing", () => {
    render(<FirstBatchHint build={b("b3", 3, 0, 3)} />);
    expect(hint()).toBeNull();
  });

  test("moving to another batch starts over", () => {
    const r = render(<FirstBatchHint build={b("b1", 3, 3, 3)} />);
    r.rerender(<FirstBatchHint build={b("b4", 3, 0, 3)} />);
    expect(hint()).toBeNull();
  });

  test("an empty batch shows nothing", () => {
    render(<FirstBatchHint build={b("b5", 0, 0, 0)} />);
    expect(hint()).toBeNull();
  });
});
