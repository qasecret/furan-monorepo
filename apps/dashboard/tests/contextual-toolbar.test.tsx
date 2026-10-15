import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  test("offers the five chips, Needs review first, and names the active one", async () => {
    const user = userEvent.setup();
    render(<ContextualToolbar {...baseProps} chip="failed" />);
    expect(screen.getByTestId("batch-filter-trigger").textContent).toContain(
      "Failed",
    );
    await user.click(screen.getByTestId("batch-filter-trigger"));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.getAttribute("data-testid"))).toEqual([
      "batch-chip-needs-review",
      "batch-chip-failed",
      "batch-chip-running",
      "batch-chip-passed",
      "batch-chip-all",
    ]);
    expect(items.map((i) => i.firstChild?.textContent)).toEqual([
      "Needs review",
      "Failed",
      "Running",
      "Passed",
      "All",
    ]);
  });

  test("each chip's tooltip states its rule", async () => {
    // A run can be both Failed and Needs review (spec §3.1): the chips are
    // filters, not a partition, so each says what it filters by.
    const user = userEvent.setup();
    render(<ContextualToolbar {...baseProps} />);
    await user.click(screen.getByTestId("batch-filter-trigger"));
    const rules: Record<string, string> = {
      "batch-chip-needs-review":
        "Tests with at least one step waiting for review",
      "batch-chip-failed": "Tests whose rollup is Failed",
      "batch-chip-running": "Tests still running",
      "batch-chip-passed": "Tests whose rollup is Passed",
      "batch-chip-all": "Every test",
    };
    for (const [testId, rule] of Object.entries(rules)) {
      const id = screen.getByTestId(testId).getAttribute("aria-describedby");
      expect(id, `${testId} has a description`).toBeTruthy();
      expect(document.getElementById(id ?? "")?.textContent).toBe(rule);
    }
  });

  test("focusing a chip shows its rule", async () => {
    const user = userEvent.setup();
    render(<ContextualToolbar {...baseProps} />);
    await user.click(screen.getByTestId("batch-filter-trigger"));
    fireEvent.focus(screen.getByTestId("batch-chip-failed"));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("Tests whose rollup is Failed");
  });

  test("the environment filters sit in the toolbar when given", () => {
    render(
      <ContextualToolbar
        {...baseProps}
        environment={<span data-testid="env-slot">filters</span>}
      />,
    );
    expect(screen.getByTestId("env-slot")).toBeDefined();
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

describe("ContextualToolbar Start reviewing", () => {
  test("names the number of pending steps and starts the review", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ContextualToolbar
        {...baseProps}
        start={{ count: 12, reason: null, onClick }}
      />,
    );
    const button = screen.getByTestId("batch-start-reviewing");
    expect(button.textContent).toBe("Start reviewing (12)");
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  test("is unavailable with a reason when nothing is pending", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ContextualToolbar
        {...baseProps}
        start={{
          count: 0,
          reason: "Nothing to review in this batch",
          onClick,
        }}
      />,
    );
    const button = screen.getByTestId("batch-start-reviewing");
    expect(button.textContent).toBe("Start reviewing (0)");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe("Nothing to review in this batch");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("shows no number until it is known, and cannot be pressed", () => {
    render(
      <ContextualToolbar
        {...baseProps}
        start={{ count: undefined, reason: null, onClick: vi.fn() }}
      />,
    );
    const button = screen.getByTestId(
      "batch-start-reviewing",
    ) as HTMLButtonElement;
    expect(button.textContent).toBe("Start reviewing");
    expect(button.disabled).toBe(true);
  });

  test("when the queue could not be read it stays pressable, names the problem, and the press retries", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ContextualToolbar
        {...baseProps}
        start={{
          count: undefined,
          failed: true,
          reason: "Couldn't load the review queue",
          onClick,
        }}
      />,
    );
    const button = screen.getByTestId(
      "batch-start-reviewing",
    ) as HTMLButtonElement;
    // Not natively disabled with nothing to say, and not an explained
    // (press-ignoring) disabled button either: it is the retry.
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(button.getAttribute("title")).toBe("Couldn't load the review queue");
    expect(button.getAttribute("aria-label")).toBe(
      "Start reviewing: Couldn't load the review queue. Press to try again.",
    );
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  test("when the queue could not be read the reason is also visible text beside the button", () => {
    render(
      <ContextualToolbar
        {...baseProps}
        start={{
          count: undefined,
          failed: true,
          reason: "Couldn't load the review queue",
          onClick: vi.fn(),
        }}
      />,
    );
    // A tooltip and an aria-label reach neither a sighted keyboard user nor a
    // touch user, so the reason is on the page too, announced politely.
    const note = screen.getByRole("status");
    expect(note.textContent).toBe("Couldn't load the review queue");
    expect(note.className).toContain("text-fg-muted");
    expect(note.className).toContain("text-2xs");
  });

  test("shows no failure text while the queue is fine or the button is merely unavailable", () => {
    const { rerender } = render(
      <ContextualToolbar
        {...baseProps}
        start={{ count: 12, reason: null, onClick: vi.fn() }}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <ContextualToolbar
        {...baseProps}
        start={{
          count: 0,
          reason: "Nothing to review in this batch",
          onClick: vi.fn(),
        }}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("is absent for a reader who may not review", () => {
    render(<ContextualToolbar {...baseProps} />);
    expect(screen.queryByTestId("batch-start-reviewing")).toBeNull();
  });
});
