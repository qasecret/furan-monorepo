import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/app/(public)/login/action", () => ({
  loginAction: vi.fn(async () => ({})),
}));

import LoginPage from "../src/app/(public)/login/page";

describe("LoginPage", () => {
  afterEach(() => cleanup());

  test("renders email + password inputs and submit", () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeDefined();
    // The "Show password" eye-toggle button has an aria-label that also
    // matches /password/i, so getByLabelText(/password/i) is ambiguous —
    // query the input by id instead.
    expect(document.getElementById("password")).not.toBeNull();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined();
  });

  test("password visibility toggle flips input type between password and text", () => {
    render(<LoginPage />);
    const input = document.getElementById("password") as HTMLInputElement;
    expect(input.type).toBe("password");

    const toggle = screen.getByTestId("password-visibility-toggle");
    fireEvent.click(toggle);
    expect(input.type).toBe("text");
    expect(toggle.getAttribute("aria-label")).toBe("Hide password");

    fireEvent.click(toggle);
    expect(input.type).toBe("password");
    expect(toggle.getAttribute("aria-label")).toBe("Show password");
  });
});
