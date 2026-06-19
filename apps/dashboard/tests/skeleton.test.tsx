import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Skeleton } from "@/components/ui/skeleton";

afterEach(cleanup);

describe("Skeleton", () => {
  test("renders a pulsing block and merges className", () => {
    render(<Skeleton className="h-4 w-10" data-testid="sk" />);
    const el = screen.getByTestId("sk");
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("h-4");
    expect(el.className).toContain("w-10");
  });
});
