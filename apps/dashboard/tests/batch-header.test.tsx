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
  testName: null,
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
  newCount: 0,
  stepsTotal: 24,
  runByName: "Jane Doe",
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("BatchHeader", () => {
  test("renders the title with the status word and batch name", () => {
    render(<BatchHeader build={data} />);
    expect(screen.getByText(/Test results of batch/i)).toBeDefined();
    expect(screen.getByText(/#42/)).toBeDefined();
    // The aggregate status renders as a coloured word before the title.
    expect(screen.getByText("Unresolved")).toBeDefined();
  });

  test("renders the Tests / Steps / Duration / Run by meta strip", () => {
    render(<BatchHeader build={data} />);
    expect(screen.getByText("Tests:")).toBeDefined();
    expect(screen.getByText("Steps:")).toBeDefined();
    expect(screen.getByText("Duration:")).toBeDefined();
    expect(screen.getByText("Run by:")).toBeDefined();
    expect(screen.getByText("Jane Doe")).toBeDefined();
  });

  test("does not render a Share action (removed — the URL is already shareable)", () => {
    render(<BatchHeader build={data} />);
    expect(screen.queryByTestId("batch-share")).toBeNull();
  });

  test("does not render the Approve all button (moved to ContextualToolbar)", () => {
    render(<BatchHeader build={data} />);
    expect(screen.queryByTestId("batch-approve-all")).toBeNull();
  });
});
