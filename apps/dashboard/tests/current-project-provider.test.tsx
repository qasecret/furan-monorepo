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

  test("is null when the default is absent and there are 2+ projects (no arbitrary pick — mirrors the landing resolver)", () => {
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="zzz"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("none");
    expect(captured?.currentProjectId).toBeNull();
  });

  test("is null when there is no default and 2+ projects", () => {
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId={null}
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("none");
  });

  test("falls back to the sole project when there's exactly one and no default", () => {
    render(
      <CurrentProjectProvider
        initialProjects={[{ id: "solo", name: "Solo" }]}
        initialDefaultProjectId={null}
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("solo");
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
      (captured as unknown as Record<string, unknown>).setCurrentProject,
    ).toBeUndefined();
  });
});
