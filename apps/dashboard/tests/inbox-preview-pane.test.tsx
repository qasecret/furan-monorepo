import type { InboxRunRow } from "@furan/shared-types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { InboxPreviewPane } from "@/app/(protected)/inbox/_components/inbox-preview-pane";

afterEach(cleanup);

const run: InboxRunRow = {
  runId: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  projectName: "demo-rabindra",
  variationName: "checkout-mobile",
  buildNumber: 142,
  buildId: "33333333-3333-3333-3333-333333333333",
  branch: "main",
  status: "unresolved",
  createdAt: new Date().toISOString(),
  thumbnailUrl: "https://x/y.webp",
};

describe("InboxPreviewPane", () => {
  test("with no run, shows the empty 'select a run' state", () => {
    render(
      <InboxPreviewPane
        run={undefined}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        isActing={false}
      />,
    );
    expect(screen.getByText(/Select a run to preview/i)).toBeDefined();
  });

  test("with a run, renders the header from the row + the thumbnail image", () => {
    const { container } = render(
      <InboxPreviewPane
        run={run}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        isActing={false}
      />,
    );
    expect(screen.getByText("checkout-mobile")).toBeDefined();
    expect(screen.getByText(/demo-rabindra/)).toBeDefined();
    expect(screen.getByText(/Build #142/)).toBeDefined();
    const img = container.querySelector("img");
    expect((img as HTMLImageElement).src).toBe("https://x/y.webp");
  });

  test("renders the placeholder when the run has no thumbnail", () => {
    const { container } = render(
      <InboxPreviewPane
        run={{ ...run, thumbnailUrl: null }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        isActing={false}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/No preview image/i)).toBeDefined();
  });

  test("Approve/Reject call handlers; Open full diff has the viewer href; isActing disables actions", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { rerender } = render(
      <InboxPreviewPane
        run={run}
        onApprove={onApprove}
        onReject={onReject}
        isActing={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("link", { name: /Open full diff/ }).getAttribute("href"),
    ).toBe(
      "/projects/22222222-2222-2222-2222-222222222222/runs/11111111-1111-1111-1111-111111111111/diffs/11111111-1111-1111-1111-111111111111",
    );

    rerender(
      <InboxPreviewPane
        run={run}
        onApprove={onApprove}
        onReject={onReject}
        isActing={true}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /Approve/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
