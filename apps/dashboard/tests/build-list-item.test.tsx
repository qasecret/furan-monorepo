import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { BuildListItem } from "@/app/(protected)/projects/[projectId]/builds/_components/build-list-item";
import type { BuildRowData } from "@/app/(protected)/projects/[projectId]/builds/_components/build-types";
import type { ReviewContext } from "@/lib/review-url";

afterEach(cleanup);

const build: BuildRowData = {
  id: "b1",
  ciBuildId: "c",
  number: 42,
  branchName: "main",
  name: null,
  testName: null,
  status: null,
  properties: {},
  projectId: "p1",
  userId: null,
  isRunning: false,
  environment: "default",
  runCount: 3,
  runningCount: 0,
  unresolvedCount: 1,
  failedCount: 0,
  passedCount: 2,
  abortedCount: 0,
  emptyCount: 0,
  pendingCheckpoints: 1,
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("BuildListItem", () => {
  test("links to the batch page and marks selection", () => {
    render(<BuildListItem build={build} projectId="p1" selected />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/projects/p1/builds/b1");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("main")).toBeDefined();
    // The aggregate status renders as a word in the row.
    expect(screen.getByText("Unresolved")).toBeDefined();
  });

  test("each build shows its pending count (hidden at 0)", () => {
    const { rerender } = render(
      <BuildListItem
        build={{ ...build, pendingCheckpoints: 7 }}
        projectId="p1"
        selected={false}
      />,
    );
    const pending = screen.getByTestId("build-list-item-pending-b1");
    expect(pending.textContent).toBe("7 pending");
    // Next to the status word, quieter than it.
    expect(pending.className).toContain("text-2xs");
    expect(pending.className).toContain("text-fg-muted");
    expect(screen.getByText("Unresolved")).toBeDefined();

    rerender(
      <BuildListItem
        build={{ ...build, pendingCheckpoints: 0 }}
        projectId="p1"
        selected={false}
      />,
    );
    expect(screen.queryByTestId("build-list-item-pending-b1")).toBeNull();
    expect(screen.queryByText(/pending/)).toBeNull();
    // The status word stays.
    expect(screen.getByText("Unresolved")).toBeDefined();
  });

  test("build links keep the review context", () => {
    const context: ReviewContext = {
      status: "failed",
      facets: { browser: "chrome", viewport: "1280x720" },
      branch: "release/2",
      q: "nav",
      props: { env: "staging" },
    };
    render(
      <BuildListItem
        build={build}
        projectId="p1"
        selected={false}
        context={context}
      />,
    );
    // Status, facets and props travel; branch and search are Batches-only.
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "/projects/p1/builds/b1?status=failed&browser=chrome&viewport=1280x720&props=env%3Astaging",
    );
  });

  test("a default context leaves the link bare", () => {
    render(
      <BuildListItem
        build={build}
        projectId="p1"
        selected={false}
        context={{ status: "needs-review", facets: {} }}
      />,
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "/projects/p1/builds/b1",
    );
  });
});
