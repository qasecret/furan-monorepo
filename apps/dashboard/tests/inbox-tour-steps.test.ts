import { describe, expect, test } from "vitest";

import { INBOX_TOUR_STEPS } from "@/app/(protected)/inbox/tour-steps";

describe("INBOX_TOUR_STEPS", () => {
  test("includes a step pointing at the batches table", () => {
    const step = INBOX_TOUR_STEPS.find(
      (s) => s.target === "#inbox-batches-table",
    );
    expect(step).toBeDefined();
    expect(step?.title).toBeTruthy();
    expect(step?.content).toBeTruthy();
  });

  test("every step has a target, title, and content", () => {
    expect(INBOX_TOUR_STEPS.length).toBeGreaterThan(0);
    for (const step of INBOX_TOUR_STEPS) {
      expect(step.target).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(step.content).toBeTruthy();
    }
  });
});
