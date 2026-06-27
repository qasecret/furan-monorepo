import { describe, expect, test } from "vitest";

import { canReviewRole, isAtLeastAdmin, isOwner } from "@/lib/roles";

describe("isAtLeastAdmin", () => {
  test("true for admin and owner", () => {
    expect(isAtLeastAdmin("admin")).toBe(true);
    expect(isAtLeastAdmin("owner")).toBe(true);
  });

  test("false for editor, guest, and empty values", () => {
    expect(isAtLeastAdmin("editor")).toBe(false);
    expect(isAtLeastAdmin("guest")).toBe(false);
    expect(isAtLeastAdmin(undefined)).toBe(false);
    expect(isAtLeastAdmin(null)).toBe(false);
  });
});

describe("isOwner", () => {
  test("true only for owner", () => {
    expect(isOwner("owner")).toBe(true);
    expect(isOwner("admin")).toBe(false);
    expect(isOwner("editor")).toBe(false);
  });
});

describe("canReviewRole", () => {
  test("owner, admin, editor can review; guest cannot", () => {
    expect(canReviewRole("owner")).toBe(true);
    expect(canReviewRole("admin")).toBe(true);
    expect(canReviewRole("editor")).toBe(true);
    expect(canReviewRole("guest")).toBe(false);
  });
});
