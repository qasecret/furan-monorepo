import { describe, expect, test } from "vitest";

import { formatBatchDateTime, plural } from "@/lib/format";

describe("plural", () => {
  test("suffix", () => {
    expect(plural(1)).toBe("");
    expect(plural(0)).toBe("s");
    expect(plural(2)).toBe("s");
  });
});

describe("formatBatchDateTime", () => {
  test("formats an absolute date with 12-hour time", () => {
    // Constructed with local components + read with local getters -> the
    // formatted output is timezone-independent.
    expect(formatBatchDateTime(new Date(2024, 10, 20, 19, 23))).toBe(
      "20 Nov 2024 at 7:23 PM",
    );
  });

  test("handles midnight and noon edges", () => {
    expect(formatBatchDateTime(new Date(2024, 0, 1, 0, 5))).toBe(
      "1 Jan 2024 at 12:05 AM",
    );
    expect(formatBatchDateTime(new Date(2024, 0, 1, 12, 0))).toBe(
      "1 Jan 2024 at 12:00 PM",
    );
  });

  test("nullish or invalid input returns an empty string", () => {
    expect(formatBatchDateTime(null)).toBe("");
    expect(formatBatchDateTime(undefined)).toBe("");
    expect(formatBatchDateTime("not a date")).toBe("");
  });
});
