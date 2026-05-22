import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import { EmptyProjectsCta } from "../src/app/(protected)/projects/_components/empty-projects-cta";

describe("EmptyProjectsCta", () => {
  afterEach(() => {
    cleanup();
  });

  test("admin sees the create-project trigger and no curl block", () => {
    render(<EmptyProjectsCta role="admin" />);
    expect(screen.getByText(/No projects yet/i)).toBeDefined();
    expect(screen.getByTestId("create-project-button")).toBeDefined();
    expect(screen.queryByTestId("empty-projects-cta-curl")).toBeNull();
  });

  test("editor sees 'ask an admin' prose, no curl snippet", () => {
    render(<EmptyProjectsCta role="editor" />);
    expect(
      screen.getByText(/You're not a member of any project yet/i),
    ).toBeDefined();
    expect(screen.queryByTestId("empty-projects-cta-curl")).toBeNull();
  });

  test("guest sees the same 'ask an admin' prose as editor", () => {
    render(<EmptyProjectsCta role="guest" />);
    expect(
      screen.getByText(/You're not a member of any project yet/i),
    ).toBeDefined();
    expect(screen.queryByTestId("empty-projects-cta-curl")).toBeNull();
  });
});
