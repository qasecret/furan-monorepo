import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Avatar } from "@/components/ui/avatar";

afterEach(cleanup);

describe("Avatar", () => {
  test("renders the initial and merges className", () => {
    render(<Avatar initial="J" className="custom" data-testid="av" />);
    const el = screen.getByTestId("av");
    expect(el.textContent).toBe("J");
    expect(el.className).toContain("custom");
  });
});
