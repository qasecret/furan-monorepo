import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  CurrentProjectProvider,
  useCurrentProject,
} from "@/app/(protected)/_components/current-project-provider";

let captured: ReturnType<typeof useCurrentProject> | null = null;

function Probe() {
  const ctx = useCurrentProject();
  captured = ctx;
  return (
    <div>
      <span data-testid="current">{ctx.currentProjectId ?? "none"}</span>
      <span data-testid="current-name">{ctx.currentProject?.name ?? "—"}</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  captured = null;
});

const projects = [
  { id: "a", name: "alpha" },
  { id: "b", name: "beta" },
];

describe("CurrentProjectProvider", () => {
  test("resolves to the default when it is among the visible projects", () => {
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="b"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("b");
    expect(screen.getByTestId("current-name").textContent).toBe("beta");
    expect(captured?.currentProject?.id).toBe("b");
  });

  test("falls back to the first project when the default is absent", () => {
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="zzz"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("a");
    expect(captured?.currentProject?.id).toBe("a");
  });

  test("falls back to the first project when there is no default", () => {
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId={null}
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("a");
  });

  test("is null with no current project when there are no projects", () => {
    render(
      <CurrentProjectProvider
        initialProjects={[]}
        initialDefaultProjectId={null}
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("none");
    expect(captured?.currentProjectId).toBeNull();
    expect(captured?.currentProject).toBeNull();
  });

  test("the context value exposes no setCurrentProject", () => {
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="a"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(captured).toBeDefined();
    expect(
      (captured as Record<string, unknown>).setCurrentProject,
    ).toBeUndefined();
  });
});
