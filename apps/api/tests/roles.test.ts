import { describe, expect, it } from "vitest";

import { isAtLeastAdmin, isOwner, roleRank } from "../src/lib/roles.js";

describe("roleRank", () => {
  it("orders owner > admin > editor > guest", () => {
    expect(roleRank("owner")).toBeGreaterThan(roleRank("admin"));
    expect(roleRank("admin")).toBeGreaterThan(roleRank("editor"));
    expect(roleRank("editor")).toBeGreaterThan(roleRank("guest"));
  });
});

describe("isAtLeastAdmin", () => {
  it("is true for admin and owner", () => {
    expect(isAtLeastAdmin("admin")).toBe(true);
    expect(isAtLeastAdmin("owner")).toBe(true);
  });

  it("is false for editor, guest, and unknown/empty values", () => {
    expect(isAtLeastAdmin("editor")).toBe(false);
    expect(isAtLeastAdmin("guest")).toBe(false);
    expect(isAtLeastAdmin(undefined)).toBe(false);
    expect(isAtLeastAdmin(null)).toBe(false);
    expect(isAtLeastAdmin("nonsense")).toBe(false);
  });
});

describe("isOwner", () => {
  it("is true only for owner", () => {
    expect(isOwner("owner")).toBe(true);
    expect(isOwner("admin")).toBe(false);
    expect(isOwner("editor")).toBe(false);
    expect(isOwner(undefined)).toBe(false);
  });
});
