import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { TokenNextStep } from "@/app/(protected)/account/tokens/_components/token-next-step";

afterEach(() => {
  cleanup();
});

describe("TokenNextStep", () => {
  test("says where the token goes and what comes next", () => {
    render(<TokenNextStep />);
    const step = screen.getByTestId("token-next-step");
    expect(step.textContent).toContain(
      "Add it to your CI secrets as FURAN_API_TOKEN.",
    );
    expect(step.querySelector("code")?.textContent).toBe("FURAN_API_TOKEN");
    expect(
      screen
        .getByRole("link", {
          name: "Send your first screenshots (opens in a new tab)",
        })
        .getAttribute("href"),
    ).toBe("/docs/getting-started/first-upload");
  });
});
