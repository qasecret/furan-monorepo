import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ContextualToolbar } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/contextual-toolbar";

afterEach(cleanup);

describe("ContextualToolbar", () => {
  test("changes filter and fires approve-all", () => {
    const onChip = vi.fn();
    const onApproveAll = vi.fn();
    render(
      <ContextualToolbar
        chip="needs-review"
        onChipChange={onChip}
        canApproveAll
        onApproveAll={onApproveAll}
        isApproving={false}
      />,
    );
    fireEvent.click(screen.getByTestId("batch-chip-passed"));
    expect(onChip).toHaveBeenCalledWith("passed");
    fireEvent.click(screen.getByTestId("batch-approve-all"));
    expect(onApproveAll).toHaveBeenCalled();
  });

  test("hides approve-all when not allowed", () => {
    render(
      <ContextualToolbar
        chip="all"
        onChipChange={vi.fn()}
        canApproveAll={false}
        onApproveAll={vi.fn()}
        isApproving={false}
      />,
    );
    expect(screen.queryByTestId("batch-approve-all")).toBeNull();
  });
});
