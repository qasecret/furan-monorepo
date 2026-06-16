import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { WhyPanel } from "../src/components/diff-viewer/WhyPanel";

describe("WhyPanel", () => {
  test("collapsed by default, expands on click", () => {
    render(
      <WhyPanel summary="heading copy changed" severity="minor" source="DOM">
        <div data-testid="region-list-body">regions</div>
      </WhyPanel>,
    );
    expect(screen.queryByTestId("region-list-body")).toBeNull();
    fireEvent.click(screen.getByTestId("why-panel-toggle"));
    expect(screen.getByTestId("region-list-body")).toBeTruthy();
  });
});
