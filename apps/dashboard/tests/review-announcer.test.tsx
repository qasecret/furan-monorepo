import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  announce,
  ReviewAnnouncer,
  reserveAnnouncement,
  useReviewAnnouncer,
} from "@/lib/review/review-announcer";

beforeEach(() => {
  vi.useFakeTimers();
  useReviewAnnouncer.setState({ text: "", seq: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
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

  test("clears its text about 7 s after the announcement", () => {
    render(<ReviewAnnouncer />);
    act(() => announce("Next test: Checkout · 4 left in batch"));
    act(() => vi.advanceTimersByTime(6_999));
    expect(screen.getByRole("status").textContent).not.toBe("");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status").textContent).toBe("");
    // The region stays mounted, empty, ready for the next one.
    act(() => announce("again"));
    expect(screen.getByRole("status").textContent).toBe("again");
  });

  test("every announcement restarts the timer", () => {
    render(<ReviewAnnouncer />);
    act(() => announce("one"));
    act(() => vi.advanceTimersByTime(5_000));
    act(() => announce("two"));
    // 7 s after the first, but only 2 s after the last.
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole("status").textContent).toBe("two");
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  test("mounting it again starts empty, whatever was said before", () => {
    const first = render(<ReviewAnnouncer />);
    act(() => announce("said before"));
    first.unmount();
    render(<ReviewAnnouncer />);
    expect(screen.getByRole("status").textContent).toBe("");
    // And it speaks again from then on.
    act(() => announce("said after"));
    expect(screen.getByRole("status").textContent).toBe("said after");
  });
});

describe("reserveAnnouncement", () => {
  test("speaks when it is still the latest", () => {
    const say = reserveAnnouncement();
    say("hello");
    expect(useReviewAnnouncer.getState().text).toBe("hello");
  });

  test("is dropped when a later reservation was made first", () => {
    const early = reserveAnnouncement();
    const late = reserveAnnouncement();
    late("later");
    early("earlier");
    expect(useReviewAnnouncer.getState().text).toBe("later");
  });

  test("says whether the words were said", () => {
    const early = reserveAnnouncement();
    const late = reserveAnnouncement();
    expect(early("too late")).toBe(false);
    expect(late("in time")).toBe(true);
    expect(useReviewAnnouncer.getState().text).toBe("in time");
  });

  test("is dropped when anything else was announced meanwhile", () => {
    const say = reserveAnnouncement();
    announce("something else");
    say("too late");
    expect(useReviewAnnouncer.getState().text).toBe("something else");
  });
});
