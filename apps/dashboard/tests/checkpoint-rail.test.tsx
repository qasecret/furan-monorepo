import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointRail } from "@/components/diff-viewer/CheckpointRail";

const checkpoints = [
  { id: "a", name: "HomePage", status: "passed" as const, diffPercent: 0 },
  {
    id: "b",
    name: "searchResult",
    status: "unresolved" as const,
    diffPercent: 5.2,
  },
  {
    id: "c",
    name: "checkoutStep1",
    status: "passed" as const,
    diffPercent: 0.1,
  },
];

afterEach(() => cleanup());

describe("CheckpointRail", () => {
  it("renders one card per checkpoint", () => {
    render(
      <CheckpointRail items={checkpoints} selectedId="b" onSelect={() => {}} />,
    );
    expect(screen.getByTestId("checkpoint-card-a")).toBeTruthy();
    expect(screen.getByTestId("checkpoint-card-b")).toBeTruthy();
    expect(screen.getByTestId("checkpoint-card-c")).toBeTruthy();
  });
  it("marks the selected card with aria-current=true", () => {
    render(
      <CheckpointRail items={checkpoints} selectedId="b" onSelect={() => {}} />,
    );
    const selected = screen.getByTestId("checkpoint-card-b");
    expect(selected.getAttribute("aria-current")).toBe("true");
  });
  it("calls onSelect when a card is clicked", () => {
    const onSelect = vi.fn();
    render(
      <CheckpointRail items={checkpoints} selectedId="b" onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByTestId("checkpoint-card-a"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });
  it("ArrowDown moves selection forward", () => {
    const onSelect = vi.fn();
    render(
      <CheckpointRail items={checkpoints} selectedId="b" onSelect={onSelect} />,
    );
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("c");
  });
  it("ArrowUp moves selection backward", () => {
    const onSelect = vi.fn();
    render(
      <CheckpointRail items={checkpoints} selectedId="b" onSelect={onSelect} />,
    );
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});
