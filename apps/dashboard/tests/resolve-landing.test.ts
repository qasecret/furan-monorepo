import { describe, expect, test } from "vitest";

import { resolveLanding } from "@/app/(protected)/_lib/resolve-landing";

describe("resolveLanding", () => {
  test("default project that's in the visible set → its Builds", () => {
    expect(
      resolveLanding({ role: "editor", defaultProjectId: "p1" }, [
        { id: "p1" },
        { id: "p2" },
      ]),
    ).toBe("/projects/p1/builds");
  });

  test("admin's default project also resolves to its Builds", () => {
    expect(
      resolveLanding({ role: "admin", defaultProjectId: "p2" }, [
        { id: "p1" },
        { id: "p2" },
      ]),
    ).toBe("/projects/p2/builds");
  });

  test("default NOT in projects but exactly one project → that project's Builds", () => {
    expect(
      resolveLanding({ role: "editor", defaultProjectId: "stale" }, [
        { id: "only" },
      ]),
    ).toBe("/projects/only/builds");
  });

  test("default null + admin + 0 projects → /admin/projects", () => {
    expect(resolveLanding({ role: "admin", defaultProjectId: null }, [])).toBe(
      "/admin/projects",
    );
  });

  test("default null + admin + 2+ projects → /admin/projects", () => {
    expect(
      resolveLanding({ role: "admin", defaultProjectId: null }, [
        { id: "p1" },
        { id: "p2" },
      ]),
    ).toBe("/admin/projects");
  });

  test("owner is treated like admin → /admin/projects", () => {
    expect(resolveLanding({ role: "owner", defaultProjectId: null }, [])).toBe(
      "/admin/projects",
    );
  });

  test("default null + editor + 0 projects → null", () => {
    expect(
      resolveLanding({ role: "editor", defaultProjectId: null }, []),
    ).toBeNull();
  });

  test("default null + editor + 2 projects → null (no switcher)", () => {
    expect(
      resolveLanding({ role: "editor", defaultProjectId: null }, [
        { id: "p1" },
        { id: "p2" },
      ]),
    ).toBeNull();
  });
});
