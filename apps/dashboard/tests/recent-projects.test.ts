import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getRecentProjects, recordRecentProject } from "@/lib/recent-projects";

const KEY = "furan:recent-projects";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("recent-projects", () => {
  test("records visits newest-first", () => {
    recordRecentProject({ id: "a", name: "Alpha" });
    recordRecentProject({ id: "b", name: "Beta" });
    expect(getRecentProjects().map((p) => p.id)).toEqual(["b", "a"]);
  });

  test("de-duplicates by id, moving the repeat to the front", () => {
    recordRecentProject({ id: "a", name: "Alpha" });
    recordRecentProject({ id: "b", name: "Beta" });
    recordRecentProject({ id: "a", name: "Alpha" });

    const ids = getRecentProjects().map((p) => p.id);
    expect(ids).toEqual(["a", "b"]);
    expect(ids.filter((x) => x === "a")).toHaveLength(1);
  });

  test("caps the list at five, keeping the five most recent", () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) {
      recordRecentProject({ id, name: id.toUpperCase() });
    }
    expect(getRecentProjects().map((p) => p.id)).toEqual([
      "g",
      "f",
      "e",
      "d",
      "c",
    ]);
  });

  test("tolerates malformed stored data", () => {
    window.localStorage.setItem(KEY, "not json");
    expect(getRecentProjects()).toEqual([]);

    window.localStorage.setItem(KEY, JSON.stringify({ not: "an array" }));
    expect(getRecentProjects()).toEqual([]);

    // Mixed array: only well-formed entries survive.
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: 1 }, { name: "x" }, { id: "ok", name: "OK" }]),
    );
    expect(getRecentProjects()).toEqual([{ id: "ok", name: "OK" }]);
  });
});
