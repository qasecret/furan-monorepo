import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

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
    render(
      <BatchHeader
        build={data}
        canApproveAll
        onApproveAll={vi.fn()}
        isApproving={false}
      />,
    );
    expect(screen.getByText(/#42/)).toBeDefined();
    expect(screen.getByText(/3 unresolved/)).toBeDefined();
    expect(screen.getByText(/region=us-east/)).toBeDefined();
  });

  test("Approve all fires when there is review work", () => {
    const onApproveAll = vi.fn();
    render(
      <BatchHeader
        build={data}
        canApproveAll
        onApproveAll={onApproveAll}
        isApproving={false}
      />,
    );
    fireEvent.click(screen.getByTestId("batch-approve-all"));
    expect(onApproveAll).toHaveBeenCalledTimes(1);
  });
});
