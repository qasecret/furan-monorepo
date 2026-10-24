import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  HistoryTable,
  type HistoryItem,
} from "../src/app/(protected)/projects/[projectId]/variations/[variationId]/_components/history-table";

afterEach(() => {
  cleanup();
});

const baseItem = (overrides: Partial<HistoryItem> = {}): HistoryItem => ({
  id: "r1",
  checkpointId: "c1",
  status: "passed",
  branchName: "main",
  diffPercent: 0,
  pixelMisMatchCount: 0,
  merge: false,
  baselineSource: null,
  buildId: null,
  buildNumber: null,
  buildName: null,
  buildCiBuildId: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("HistoryTable", () => {
  test("promotion chip shows when merge=true AND baselineSource is set", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[baseItem({ merge: true, baselineSource: "this_branch" })]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByTestId("history-row-promotion-r1")).toBeDefined();
  });

  test("promotion chip hidden when merge=false even if baselineSource set", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[baseItem({ merge: false, baselineSource: "this_branch" })]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.queryByTestId("history-row-promotion-r1")).toBeNull();
  });

  test("promotion chip hidden when baselineSource is null", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[baseItem({ merge: true, baselineSource: null })]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.queryByTestId("history-row-promotion-r1")).toBeNull();
  });

  test("shows each variation's own diff % and pixel count, not a shared run total", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[
          baseItem({ id: "r1", diffPercent: 0.5, pixelMisMatchCount: 1200 }),
          baseItem({ id: "r2", diffPercent: 12.25, pixelMisMatchCount: 30 }),
          // A step with no result of its own (failed, or still diffing).
          baseItem({ id: "r3", diffPercent: null, pixelMisMatchCount: null }),
          baseItem({ id: "r4", diffPercent: 0, pixelMisMatchCount: 0 }),
        ]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    const cells = (id: string) =>
      Array.from(
        screen.getByTestId(`history-row-${id}`).querySelectorAll("td"),
      ).map((td) => td.textContent);
    // Columns: when, status, branch, diff %, pixels.
    expect(cells("r1").slice(3, 5)).toEqual(["0.50%", "1,200"]);
    expect(cells("r2").slice(3, 5)).toEqual(["12.25%", "30"]);
    expect(cells("r3").slice(3, 5)).toEqual(["—", "—"]);
    expect(cells("r4").slice(3, 5)).toEqual(["0.00%", "0"]);
  });

  test("#N opens /builds/:buildId", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[baseItem({ buildId: "b1", buildNumber: 42 })]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    const link = screen.getByTestId("history-row-build-r1");
    expect(link.textContent).toMatch(/#42/);
    // That batch's page, not the builds list with a query nothing reads.
    expect(link.getAttribute("href")).toBe("/projects/p1/builds/b1");
  });

  test("a build without a number still links to its batch, by its display name", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[
          baseItem({ id: "r1", buildId: "b-named", buildName: "nightly" }),
          baseItem({
            id: "r2",
            buildId: "b-ci",
            buildCiBuildId: "ci-123456789012345",
          }),
          baseItem({ id: "r3", buildId: "0123456789abcdef" }),
        ]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    const named = screen.getByRole("link", { name: "nightly" });
    expect(named.getAttribute("href")).toBe("/projects/p1/builds/b-named");
    // The display name's own fallbacks: the CI id's first 12, then the id's 8.
    expect(
      screen.getByRole("link", { name: "ci-123456789" }).getAttribute("href"),
    ).toBe("/projects/p1/builds/b-ci");
    expect(
      screen.getByRole("link", { name: "01234567" }).getAttribute("href"),
    ).toBe("/projects/p1/builds/0123456789abcdef");
    expect(screen.getByTestId("history-row-build-r1").textContent).toBe(
      "nightly",
    );
  });

  test("build column shows em-dash when no build", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[baseItem({ buildId: null, buildNumber: null })]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.queryByTestId("history-row-build-r1")).toBeNull();
  });

  test("View diff → opens /runs/:runId/checkpoints/:checkpointId", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[baseItem({ id: "run-xyz", checkpointId: "step-9" })]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    // The exact step of that run, so the viewer never lands on "Step —".
    expect(
      screen.getByTestId("history-row-view-diff-run-xyz").getAttribute("href"),
    ).toBe("/projects/p1/runs/run-xyz/checkpoints/step-9");
  });

  test("each row opens its own run's step", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[
          baseItem({ id: "run-a", checkpointId: "step-a" }),
          baseItem({ id: "run-b", checkpointId: "step-b" }),
        ]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    expect(
      screen.getByTestId("history-row-view-diff-run-a").getAttribute("href"),
    ).toBe("/projects/p1/runs/run-a/checkpoints/step-a");
    expect(
      screen.getByTestId("history-row-view-diff-run-b").getAttribute("href"),
    ).toBe("/projects/p1/runs/run-b/checkpoints/step-b");
  });

  test("Load more button rendered only when nextCursor set", () => {
    const { rerender } = render(
      <HistoryTable
        projectId="p1"
        items={[baseItem()]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    expect(screen.queryByTestId("history-load-more")).toBeNull();

    rerender(
      <HistoryTable
        projectId="p1"
        items={[baseItem()]}
        nextCursor="some-cursor"
        onLoadMore={() => {}}
      />,
    );
    expect(screen.getByTestId("history-load-more")).toBeDefined();
  });
});
