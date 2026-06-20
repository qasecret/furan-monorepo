import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// redirect() throws in real Next to abort rendering; emulate that with a
// sentinel so we can both assert the target and stop execution like prod does.
class RedirectError extends Error {
  constructor(public to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}
const redirectMock = vi.fn((to: string) => {
  throw new RedirectError(to);
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirectMock(to),
}));

vi.mock("@/lib/api-client", () => ({ apiGet: vi.fn() }));

import HomePage from "@/app/(protected)/home/page";
import ProjectsPage from "@/app/(protected)/projects/page";
import { apiGet } from "@/lib/api-client";

// Route each call by path so a page issuing /users/me + /projects in parallel
// gets the right payload regardless of resolution order.
function stubApi(
  me: { role: string; defaultProjectId: string | null } | null,
  projects: { id: string }[],
) {
  vi.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path === "/users/me") return { status: 200, data: me };
    if (path === "/projects") return { status: 200, data: projects };
    return { status: 404, data: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

async function expectRedirect(page: Promise<unknown>, to: string) {
  await expect(page).rejects.toThrow(`NEXT_REDIRECT:${to}`);
}

afterEach(() => {
  cleanup();
  redirectMock.mockClear();
});

describe("/home landing resolver", () => {
  test("redirects to the default project's Builds", async () => {
    stubApi({ role: "editor", defaultProjectId: "p1" }, [
      { id: "p1" },
      { id: "p2" },
    ]);
    await expectRedirect(HomePage(), "/projects/p1/builds");
  });

  test("admin with no default lands on the Admin → Projects hub", async () => {
    stubApi({ role: "admin", defaultProjectId: null }, [
      { id: "p1" },
      { id: "p2" },
    ]);
    await expectRedirect(HomePage(), "/admin/projects");
  });

  test("editor with no project renders the no-project state (no redirect)", async () => {
    stubApi({ role: "editor", defaultProjectId: null }, []);
    render(await HomePage());
    expect(screen.getByTestId("no-project")).toBeDefined();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe("/projects relocation", () => {
  test("admins are forwarded to the Admin → Projects hub", async () => {
    stubApi({ role: "admin", defaultProjectId: "p1" }, [{ id: "p1" }]);
    await expectRedirect(ProjectsPage(), "/admin/projects");
  });

  test("editor with a default is forwarded to its Builds", async () => {
    stubApi({ role: "editor", defaultProjectId: "p1" }, [{ id: "p1" }]);
    await expectRedirect(ProjectsPage(), "/projects/p1/builds");
  });

  test("editor with no project renders the no-project state", async () => {
    stubApi({ role: "editor", defaultProjectId: null }, []);
    render(await ProjectsPage());
    expect(screen.getByTestId("no-project")).toBeDefined();
  });
});
