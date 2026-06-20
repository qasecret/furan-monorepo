import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { PageContainer } from "@/components/ui/page-container";

afterEach(cleanup);

describe("PageContainer", () => {
  test("centered (default): renders a scroll region + a max-w-7xl centered inner", () => {
    const { container: _container } = render(
      <PageContainer>
        <p>body</p>
      </PageContainer>,
    );
    const scroll = screen.getByTestId("page-scroll");
    expect(scroll.className).toContain("overflow-y-auto");
    const inner = scroll.firstElementChild as HTMLElement;
    expect(inner.className).toContain("mx-auto");
    expect(inner.className).toContain("max-w-7xl");
    expect(screen.getByText("body")).toBeDefined();
  });

  test("maxWidth='3xl' narrows the centered inner", () => {
    render(
      <PageContainer maxWidth="3xl">
        <p>x</p>
      </PageContainer>,
    );
    const inner = screen.getByTestId("page-scroll")
      .firstElementChild as HTMLElement;
    expect(inner.className).toContain("max-w-3xl");
    expect(inner.className).not.toContain("max-w-7xl");
  });

  test("fullBleed: renders a bounded flex column, no scroll region or max-width", () => {
    render(
      <PageContainer fullBleed>
        <p>bleed</p>
      </PageContainer>,
    );
    const el = screen.getByTestId("page-bleed");
    expect(el.className).toContain("flex");
    expect(el.className).toContain("min-h-0");
    expect(el.className).toContain("flex-1");
    expect(el.className).toContain("flex-col");
    expect(el.className).not.toContain("overflow-y-auto");
    expect(el.className).not.toContain("max-w-7xl");
    expect(screen.queryByTestId("page-scroll")).toBeNull();
  });
});
