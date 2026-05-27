import type { InboxRunRow } from "@furan/shared-types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { QueueRow } from "@/components/triage/queue-row";

afterEach(cleanup);

const row: InboxRunRow = {
  runId: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  projectName: "demo-rabindra",
  variationName: "checkout-mobile",
  buildNumber: 142,
  branch: "main",
  status: "unresolved",
  createdAt: new Date(Date.now() - 7200_000).toISOString(),
  thumbnailUrl: null,
};

describe("QueueRow", () => {
  test("renders variation name + project name + status + relative time", () => {
    render(
      <QueueRow
        row={row}
        selected={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("checkout-mobile")).toBeDefined();
    expect(screen.getByText(/demo-rabindra/)).toBeDefined();
    expect(screen.getByText("Unresolved")).toBeDefined();
    expect(screen.getByText(/2h ago/i)).toBeDefined();
  });

  test("renders thumbnail when URL provided, placeholder otherwise", () => {
    const { rerender } = render(
      <QueueRow
        row={row}
        selected={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();

    rerender(
      <QueueRow
        row={{ ...row, thumbnailUrl: "https://x/y.webp" }}
        selected={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect((screen.getByRole("img") as HTMLImageElement).src).toBe(
      "https://x/y.webp",
    );
  });
});
