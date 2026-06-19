import { describe, expect, test } from "vitest";

import { INBOX_TOUR_STEPS } from "@/app/(protected)/inbox/tour-steps";

describe("INBOX_TOUR_STEPS", () => {
  test("includes a step pointing at the preview pane", () => {
    const step = INBOX_TOUR_STEPS.find(
      (s) => s.target === "#inbox-preview-pane",
    );
    expect(step).toBeDefined();
    expect(step?.title).toBeTruthy();
    expect(step?.content).toBeTruthy();
  });
});
