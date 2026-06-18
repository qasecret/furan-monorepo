import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

import {
  TestCard,
  type TestCardData,
} from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/test-card";

afterEach(cleanup);

const base: TestCardData = {
  id: "run-1111-1111-1111-111111111111",
  name: "Checkout · payment",
  status: "unresolved",
  diffPercent: 2.4,
  thumbnailUrl: null,
};

describe("TestCard", () => {
  test("renders name, status, change, and a placeholder when no thumbnail", () => {
    const { container } = render(
      <TestCard
        projectId="p1"
        row={base}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("Checkout · payment")).toBeDefined();
    expect(screen.getByText(/2\.4/)).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
  });

  test("renders the thumbnail when present", () => {
    const { container } = render(
      <TestCard
        projectId="p1"
        row={{ ...base, thumbnailUrl: "https://x/y.webp" }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect((container.querySelector("img") as HTMLImageElement).src).toBe(
      "https://x/y.webp",
    );
  });

  test("approve/reject fire with the runId", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <TestCard
        projectId="p1"
        row={base}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByTestId(`test-card-approve-${base.id}`));
    fireEvent.click(screen.getByTestId(`test-card-reject-${base.id}`));
    expect(onApprove).toHaveBeenCalledWith(base.id);
    expect(onReject).toHaveBeenCalledWith(base.id);
  });

  test("clicking the card navigates to the diff viewer", () => {
    pushMock.mockClear();
    render(
      <TestCard
        projectId="p1"
        row={base}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId(`test-card-${base.id}`));
    expect(pushMock).toHaveBeenCalledWith(
      `/projects/p1/runs/${base.id}/checkpoints/_first`,
    );
  });

  test("pressing Enter on the card navigates to the diff viewer", () => {
    pushMock.mockClear();
    render(
      <TestCard
        projectId="p1"
        row={base}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByTestId(`test-card-${base.id}`), {
      key: "Enter",
    });
    expect(pushMock).toHaveBeenCalledWith(
      `/projects/p1/runs/${base.id}/checkpoints/_first`,
    );
  });
});
