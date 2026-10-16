import { describe, expect, it } from "vitest";

import { matchesBatchSearch } from "@/lib/build-display-name";

describe("matchesBatchSearch", () => {
  it("finds a batch by its name", () => {
    const b = { name: "Checkout flow", branchName: "main", id: "b1" };
    expect(matchesBatchSearch(b, "checkout")).toBe(true);
    expect(matchesBatchSearch(b, "flow")).toBe(true);
    expect(matchesBatchSearch(b, "profile")).toBe(false);
  });

  it("finds a batch by its branch", () => {
    const b = { name: "Nightly", branchName: "release/1.2", id: "b1" };
    expect(matchesBatchSearch(b, "release")).toBe(true);
    expect(matchesBatchSearch(b, "1.2")).toBe(true);
    expect(matchesBatchSearch(b, "hotfix")).toBe(false);
    // No branch: only the name can match.
    expect(
      matchesBatchSearch({ name: "Nightly", branchName: null }, "main"),
    ).toBe(false);
  });

  it("finds a batch with no name by its #number", () => {
    const b = { number: 42, branchName: "main", id: "b1" };
    expect(matchesBatchSearch(b, "#42")).toBe(true);
    expect(matchesBatchSearch(b, "42")).toBe(true);
    expect(matchesBatchSearch(b, "#43")).toBe(false);
    // Titled by its one test, the title is what is searched.
    const test = { testName: "checkout smoke", number: 7, id: "b2" };
    expect(matchesBatchSearch(test, "smoke")).toBe(true);
    expect(matchesBatchSearch(test, "#7")).toBe(false);
  });

  it("ignores case, in the text and in the batch", () => {
    const b = { name: "Checkout FLOW", branchName: "Release/Main", id: "b1" };
    expect(matchesBatchSearch(b, "checkout flow")).toBe(true);
    expect(matchesBatchSearch(b, "CHECKOUT")).toBe(true);
    expect(matchesBatchSearch(b, "release/main")).toBe(true);
    expect(matchesBatchSearch(b, "RELEASE/MAIN")).toBe(true);
  });
});
