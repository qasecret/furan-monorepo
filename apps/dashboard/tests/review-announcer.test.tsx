import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  announce,
  ReviewAnnouncer,
  useReviewAnnouncer,
} from "@/lib/review/review-announcer";

beforeEach(() => {
  useReviewAnnouncer.setState({ text: "", seq: 0 });
});

afterEach(() => {
  cleanup();
});

describe("ReviewAnnouncer", () => {
  test("is a polite, atomic, visually hidden live region, empty until something is said", () => {
    render(<ReviewAnnouncer />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.className).toContain("sr-only");
    expect(region.textContent).toBe("");
  });

  test("says what announce() is given, from outside React", () => {
    render(<ReviewAnnouncer />);
    act(() => announce("Next test: Checkout · 4 left in batch"));
    expect(screen.getByRole("status").textContent).toBe(
      "Next test: Checkout · 4 left in batch",
    );
  });

  test("the same words twice are a new node each time, so they are announced again", () => {
    render(<ReviewAnnouncer />);
    act(() => announce("Next test: Checkout · 4 left in batch"));
    const first = screen.getByRole("status").firstElementChild;
    act(() => announce("Next test: Checkout · 4 left in batch"));
    const second = screen.getByRole("status").firstElementChild;
    expect(second).not.toBe(first);
    expect(second?.textContent).toBe("Next test: Checkout · 4 left in batch");
  });

  test("keeps the region mounted across announcements", () => {
    render(<ReviewAnnouncer />);
    const region = screen.getByRole("status");
    act(() => announce("one"));
    act(() => announce("two"));
    expect(screen.getByRole("status")).toBe(region);
  });
});
