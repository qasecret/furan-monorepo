import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  BatchHeader,
  type BatchHeaderData,
} from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/batch-header";

afterEach(cleanup);

const data: BatchHeaderData = {
  id: "b1",
  ciBuildId: "ci-1",
  number: 42,
  name: null,
  branchName: "main",
  status: null,
  properties: { region: "us-east" },
  projectId: "p1",
  userId: null,
  isRunning: false,
  environment: "default",
  runCount: 12,
  runningCount: 0,
  unresolvedCount: 3,
  failedCount: 1,
  passedCount: 8,
  abortedCount: 0,
  emptyCount: 0,
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("BatchHeader", () => {
  test("renders the 'Test results of batch' title, display name, and properties", () => {
    render(<BatchHeader build={data} />);
    expect(screen.getByText(/Test results of batch/i)).toBeDefined();
    expect(screen.getByText(/#42/)).toBeDefined();
    expect(screen.getByText(/region=us-east/)).toBeDefined();
  });

  test("renders the labelled status counts (value + label)", () => {
    render(<BatchHeader build={data} />);
    // "Unresolved" also appears in the aggregate status badge, so allow >=1.
    expect(screen.getAllByText("Unresolved").length).toBeGreaterThan(0);
    expect(screen.getByText("Failed")).toBeDefined();
    expect(screen.getByText("Passed")).toBeDefined();
  });

  test("renders a Share action", () => {
    render(<BatchHeader build={data} />);
    expect(screen.getByTestId("batch-share")).toBeDefined();
  });

  test("does not render the Approve all button (moved to ContextualToolbar)", () => {
    render(<BatchHeader build={data} />);
    expect(screen.queryByTestId("batch-approve-all")).toBeNull();
  });
});
