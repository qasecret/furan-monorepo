import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/inbox",
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  CURRENT_PROJECT_SESSION_KEY,
  CurrentProjectProvider,
  useCurrentProject,
} from "@/app/(protected)/_components/current-project-provider";

function Probe() {
  const { currentProjectId, setCurrentProject } = useCurrentProject();
  return (
    <div>
      <span data-testid="current">{currentProjectId ?? "none"}</span>
      <button data-testid="switch-b" onClick={() => setCurrentProject("b")}>
        switch
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

const projects = [
  { id: "a", name: "alpha" },
  { id: "b", name: "beta" },
];

describe("CurrentProjectProvider", () => {
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

  test("an accessible session-stored project wins over the default", async () => {
    window.sessionStorage.setItem(CURRENT_PROJECT_SESSION_KEY, "a");
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="b"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("a"),
    );
  });

  test("a stale session value is ignored (falls to default)", async () => {
    window.sessionStorage.setItem(CURRENT_PROJECT_SESSION_KEY, "zzz");
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="b"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("b"),
    );
  });

  test("switching is transient: writes sessionStorage (no persistence call)", async () => {
    const user = userEvent.setup();
    render(
      <CurrentProjectProvider
        initialProjects={projects}
        initialDefaultProjectId="a"
      >
        <Probe />
      </CurrentProjectProvider>,
    );
    await user.click(screen.getByTestId("switch-b"));
    expect(screen.getByTestId("current").textContent).toBe("b");
    expect(window.sessionStorage.getItem(CURRENT_PROJECT_SESSION_KEY)).toBe(
      "b",
    );
  });
});
