import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { EmptyState } from "@/components/ui/empty-state";

afterEach(cleanup);

describe("EmptyState", () => {
  test("renders title, description, and action", () => {
    render(
      <EmptyState
        title="No builds yet"
        description="Connect the SDK to start."
        action={<button>Create token</button>}
      />,
    );
    expect(screen.getByText("No builds yet")).toBeDefined();
    expect(screen.getByText("Connect the SDK to start.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Create token" })).toBeDefined();
  });

  test("renders without optional props", () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeDefined();
  });
});
