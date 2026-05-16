import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("../src/app/(public)/login/action", () => ({
  loginAction: vi.fn(async () => ({})),
}));

import LoginPage from "../src/app/(public)/login/page";

describe("LoginPage", () => {
  test("renders email + password inputs and submit", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeDefined();
    expect(screen.getByLabelText(/password/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined();
  });
});
