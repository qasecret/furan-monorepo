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
  status: "passed",
  branchName: "main",
  diffPercent: 0,
  pixelMisMatchCount: 0,
  merge: false,
  baselineSource: null,
  buildId: null,
  buildNumber: null,
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

  test("build column shows #buildNumber link when present", () => {
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
    expect(link.getAttribute("href")).toBe("/projects/p1/builds?expand=b1");
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

  test("View diff link points to runs/[id]/diffs/[id]", () => {
    render(
      <HistoryTable
        projectId="p1"
        items={[baseItem({ id: "run-xyz" })]}
        nextCursor={null}
        onLoadMore={() => {}}
      />,
    );
    expect(
      screen.getByTestId("history-row-view-diff-run-xyz").getAttribute("href"),
    ).toBe("/projects/p1/runs/run-xyz/diffs/run-xyz");
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
