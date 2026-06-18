import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RejectClusterDialog } from "../src/app/(protected)/inbox/_components/reject-cluster-dialog";

afterEach(cleanup);

const props = {
  open: true,
  runCount: 3,
  buildCount: 2,
  runNames: ["Checkout", "Search"],
  isPending: false,
  onOpenChange: () => undefined,
  onConfirm: () => undefined,
};

describe("RejectClusterDialog", () => {
  it("describes the run/build blast radius and lists visible runs", () => {
    render(<RejectClusterDialog {...props} />);
    const dialog = screen.getByTestId("reject-cluster-dialog");
    expect(dialog.textContent).toContain("3 runs");
    expect(dialog.textContent).toContain("2 builds");
    expect(dialog.textContent).toContain("failed");
    expect(screen.getByTestId("reject-cluster-run-list").textContent).toContain(
      "Checkout",
    );
  });

  it("confirm fires onConfirm; disabled while pending", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <RejectClusterDialog {...props} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByTestId("reject-cluster-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(
      <RejectClusterDialog {...props} isPending onConfirm={onConfirm} />,
    );
    expect(
      (screen.getByTestId("reject-cluster-confirm") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
