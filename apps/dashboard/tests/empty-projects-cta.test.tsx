import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { EmptyProjectsCta } from "../src/app/(protected)/projects/_components/empty-projects-cta";

describe("EmptyProjectsCta", () => {
  afterEach(() => {
    cleanup();
  });

  test("admin sees the API-create snippet + curl example", () => {
    render(<EmptyProjectsCta role="admin" />);
    expect(screen.getByText(/No projects yet/i)).toBeDefined();
    expect(screen.getByTestId("empty-projects-cta-curl")).toBeDefined();
    expect(screen.getByText(/POST .*\/projects/)).toBeDefined();
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
