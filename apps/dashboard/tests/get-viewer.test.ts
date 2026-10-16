import { beforeEach, describe, expect, test, vi } from "vitest";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiGet }));
// React's `cache()` keeps one answer per server request. Outside a server
// render it caches nothing, so stand in for the request: one answer per
// module instance, and each test loads a fresh instance.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: <T>(fn: () => T): (() => T) => {
      let answer: { value: T } | null = null;
      return () => (answer ??= { value: fn() }).value;
    },
  };
});

/** The module as one request sees it. */
async function request() {
  vi.resetModules();
  return import("@/lib/get-viewer");
}

beforeEach(() => {
  apiGet.mockReset();
});

describe("getViewer", () => {
  test("is the id and the role from /users/me", async () => {
    apiGet.mockResolvedValue({
      status: 200,
      data: { id: "u1", role: "editor", email: "e@x" },
    });
    const { getViewer } = await request();
    expect(await getViewer()).toEqual({ id: "u1", role: "editor" });
    expect(apiGet).toHaveBeenCalledWith("/users/me");
  });

  test("getViewerRole is its role, from the same one call", async () => {
    apiGet.mockResolvedValue({
      status: 200,
      data: { id: "u1", role: "admin" },
    });
    const { getViewer, getViewerRole } = await request();
    const [viewer, role] = await Promise.all([getViewer(), getViewerRole()]);
    expect(viewer).toEqual({ id: "u1", role: "admin" });
    expect(role).toBe("admin");
    expect(apiGet).toHaveBeenCalledOnce();
  });

  test.each([
    ["a failed lookup", () => apiGet.mockRejectedValue(new Error("down"))],
    ["no user", () => apiGet.mockResolvedValue({ status: 404, data: null })],
  ])("%s is a guest with no id", async (_label, arrange) => {
    arrange();
    const { getViewer, getViewerRole } = await request();
    expect(await getViewer()).toEqual({ id: null, role: "guest" });
    expect(await getViewerRole()).toBe("guest");
  });
});
