import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { ProjectIdRow } from "@/app/(protected)/projects/[projectId]/settings/_components/project-id-row";

afterEach(() => {
  cleanup();
});

describe("ProjectIdRow", () => {
  test("shows the project ID to copy", () => {
    render(<ProjectIdRow projectId="p1" />);
    expect(screen.getByText("Project ID")).toBeDefined();
    expect(
      screen.getByTestId("project-id").querySelector("code")?.textContent,
    ).toBe("p1");
    expect(
      screen.getByRole("button", { name: "Copy project ID" }),
    ).toBeDefined();
  });
});
