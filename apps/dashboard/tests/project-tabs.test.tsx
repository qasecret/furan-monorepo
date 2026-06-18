import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/builds",
}));

import { ProjectTabs } from "@/app/(protected)/projects/[projectId]/_components/project-tabs";

afterEach(cleanup);

describe("ProjectTabs", () => {
  test("renders Builds / Variations / Settings and NO Runs tab", () => {
    render(<ProjectTabs projectId="p1" />);
    expect(screen.getByText("Builds")).toBeDefined();
    expect(screen.getByText("Variations")).toBeDefined();
    expect(screen.getByText("Settings")).toBeDefined();
    expect(screen.queryByText("Runs")).toBeNull();
  });
});
