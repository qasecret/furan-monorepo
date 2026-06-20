import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/inbox",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    account: {
      setDefaultProject: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

import {
  CurrentProjectProvider,
  useCurrentProject,
} from "@/app/(protected)/_components/current-project-provider";

function Probe() {
  const { currentProjectId } = useCurrentProject();
  return <div data-testid="current">{currentProjectId ?? "none"}</div>;
}

afterEach(cleanup);

describe("CurrentProjectProvider resolution", () => {
  const projects = [
    { id: "a", name: "alpha" },
    { id: "b", name: "beta" },
  ];
  test("uses the default project when accessible", () => {
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="b"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("b");
  });
  test("falls back to first project when default is stale", () => {
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="zzz"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("a");
  });
  test("is null when there are no projects", () => {
    render(
      <CurrentProjectProvider
        initialProjects={[]}
        initialDefaultProjectId={null}
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("none");
  });
});
