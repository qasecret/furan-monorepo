import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { BuildListItem } from "@/app/(protected)/projects/[projectId]/builds/_components/build-list-item";
import type { BuildRowData } from "@/app/(protected)/projects/[projectId]/builds/_components/build-row";

afterEach(cleanup);

const build: BuildRowData = {
  id: "b1",
  ciBuildId: "c",
  number: 42,
  branchName: "main",
  name: null,
  properties: {},
  runCount: 3,
  unresolvedCount: 1,
  failedCount: 0,
  passedCount: 2,
  abortedCount: 0,
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
};

describe("BuildListItem", () => {
  test("links to the batch page and marks selection", () => {
    render(<BuildListItem build={build} projectId="p1" selected />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/projects/p1/builds/b1");
    expect(link.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("main")).toBeDefined();
  });
});
