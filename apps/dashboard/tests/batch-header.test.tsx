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
  properties: { region: "us-east" },
  runCount: 12,
  unresolvedCount: 3,
  failedCount: 1,
  passedCount: 8,
  abortedCount: 0,
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
};

describe("BatchHeader", () => {
  test("renders display name, summary counts, and properties", () => {
    render(<BatchHeader build={data} />);
    expect(screen.getByText(/#42/)).toBeDefined();
    expect(screen.getByText(/3 unresolved/)).toBeDefined();
    expect(screen.getByText(/region=us-east/)).toBeDefined();
  });

  test("does not render the Approve all button (moved to ContextualToolbar)", () => {
    render(<BatchHeader build={data} />);
    expect(screen.queryByTestId("batch-approve-all")).toBeNull();
  });
});
