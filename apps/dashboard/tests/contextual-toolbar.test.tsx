import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ContextualToolbar } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/contextual-toolbar";

afterEach(cleanup);

const baseProps = {
  chip: "needs-review" as const,
  view: "list" as const,
  onChipChange: vi.fn(),
  onViewChange: vi.fn(),
  onRefresh: vi.fn(),
  isRefreshing: false,
  canApproveAll: true,
  onApproveAll: vi.fn(),
  isApproving: false,
};

describe("ContextualToolbar", () => {
  test("switches view, refreshes, and fires approve-all", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const onRefresh = vi.fn();
    const onApproveAll = vi.fn();
    render(
      <ContextualToolbar
        {...baseProps}
        onViewChange={onViewChange}
        onRefresh={onRefresh}
        onApproveAll={onApproveAll}
      />,
    );
    await user.click(screen.getByTestId("batch-view-grid"));
    expect(onViewChange).toHaveBeenCalledWith("grid");
    await user.click(screen.getByTestId("batch-refresh"));
    expect(onRefresh).toHaveBeenCalled();
    await user.click(screen.getByTestId("batch-approve-all"));
    expect(onApproveAll).toHaveBeenCalled();
  });

  test("changes the status filter through the filter dropdown", async () => {
    const user = userEvent.setup();
    const onChipChange = vi.fn();
    render(<ContextualToolbar {...baseProps} onChipChange={onChipChange} />);
    await user.click(screen.getByTestId("batch-filter-trigger"));
    await user.click(screen.getByTestId("batch-chip-passed"));
    expect(onChipChange).toHaveBeenCalledWith("passed");
  });

  test("hides approve-all when not allowed", () => {
    render(<ContextualToolbar {...baseProps} canApproveAll={false} />);
    expect(screen.queryByTestId("batch-approve-all")).toBeNull();
  });
});
