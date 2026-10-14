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
  canApprovePending: true,
  pendingCount: 37,
  onApprovePending: vi.fn(),
};

describe("ContextualToolbar", () => {
  test("switches view, refreshes, and asks to approve the pending steps", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    const onRefresh = vi.fn();
    const onApprovePending = vi.fn();
    render(
      <ContextualToolbar
        {...baseProps}
        onViewChange={onViewChange}
        onRefresh={onRefresh}
        onApprovePending={onApprovePending}
      />,
    );
    await user.click(screen.getByTestId("batch-view-grid"));
    expect(onViewChange).toHaveBeenCalledWith("grid");
    await user.click(screen.getByTestId("batch-refresh"));
    expect(onRefresh).toHaveBeenCalled();
    await user.click(screen.getByTestId("batch-approve-all"));
    expect(onApprovePending).toHaveBeenCalledOnce();
  });

  test("changes the status filter through the filter dropdown", async () => {
    const user = userEvent.setup();
    const onChipChange = vi.fn();
    render(<ContextualToolbar {...baseProps} onChipChange={onChipChange} />);
    await user.click(screen.getByTestId("batch-filter-trigger"));
    await user.click(screen.getByTestId("batch-chip-passed"));
    expect(onChipChange).toHaveBeenCalledWith("passed");
  });

  test("names the number of pending steps on the approve button", () => {
    render(<ContextualToolbar {...baseProps} pendingCount={37} />);
    const button = screen.getByTestId("batch-approve-all") as HTMLButtonElement;
    expect(button.textContent).toContain("Approve pending (37)");
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });

  test("the approve button is unavailable when nothing is pending, and says why", async () => {
    const user = userEvent.setup();
    const onApprovePending = vi.fn();
    render(
      <ContextualToolbar
        {...baseProps}
        pendingCount={0}
        onApprovePending={onApprovePending}
      />,
    );
    const button = screen.getByTestId("batch-approve-all") as HTMLButtonElement;
    expect(button.textContent).toContain("Approve pending (0)");
    // Unavailable but not natively disabled, so it can keep focus (and be
    // reached) when the last pending step has just been approved.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe("Nothing pending to approve");
    await user.click(button);
    expect(onApprovePending).not.toHaveBeenCalled();
  });

  test("the approve button is available while steps are pending", () => {
    render(<ContextualToolbar {...baseProps} pendingCount={3} />);
    const button = screen.getByTestId("batch-approve-all");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  test("hides the approve button when the reader may not review", () => {
    render(<ContextualToolbar {...baseProps} canApprovePending={false} />);
    expect(screen.queryByTestId("batch-approve-all")).toBeNull();
  });
});
