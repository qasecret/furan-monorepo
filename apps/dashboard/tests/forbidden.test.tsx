import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Forbidden } from "@/components/ui/forbidden";

afterEach(cleanup);

describe("Forbidden", () => {
  test("renders the title and description", () => {
    render(
      <Forbidden
        title="403 — admin only"
        description="You need the admin role."
      />,
    );
    expect(screen.getByText("403 — admin only")).toBeDefined();
    expect(screen.getByText("You need the admin role.")).toBeDefined();
  });
});
