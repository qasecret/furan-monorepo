import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import NotFound from "../src/app/not-found";

describe("NotFound", () => {
  afterEach(() => cleanup());

  test("offers a way back to the projects list", () => {
    render(<NotFound />);
    const link = screen.getByRole("link", { name: "Back to projects" });
    expect(link.getAttribute("href")).toBe("/projects");
  });

  test("styles the way back as the shared secondary Button", () => {
    render(<NotFound />);
    const link = screen.getByRole("link", { name: "Back to projects" });
    // The Button primitive's secondary variant, not a hand-built copy of it.
    for (const cls of ["bg-raised", "shadow-raised", "hover:bg-hover"]) {
      expect(link.classList.contains(cls), cls).toBe(true);
    }
    expect(link.classList.contains("focus-ring")).toBe(true);
    expect(link.classList.contains("text-fg-secondary")).toBe(true);
  });
});
