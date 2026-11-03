import { describe, expect, it, vi } from "vitest";

// The layout is a server component; its data calls are replaced, and the
// shell is left out: what is under test is where a refused session goes.
const { apiGetMock, redirectMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  redirectMock: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: redirectMock,
}));
vi.mock("@/lib/auth", () => ({ requireJwt: vi.fn(async () => "jwt") }));
vi.mock("@/lib/api-client", () => ({ apiGet: apiGetMock }));
vi.mock("@/app/(protected)/_components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));

import ProtectedLayout from "@/app/(protected)/layout";

function meStatus(status: number) {
  apiGetMock.mockImplementation(async (path: string) =>
    path === "/users/me"
      ? { status, data: null }
      : { status, data: status === 200 ? [] : null },
  );
}

describe("ProtectedLayout session check", () => {
  it("sends an expired or unknown session to sign in, not to a guest shell", async () => {
    meStatus(401);
    await expect(
      ProtectedLayout({ children: <div>page</div> }),
    ).rejects.toThrow("redirect:/login");
  });

  it("sends a deactivated account to sign in with its reason", async () => {
    meStatus(403);
    await expect(
      ProtectedLayout({ children: <div>page</div> }),
    ).rejects.toThrow("redirect:/login?reason=account_inactive");
  });
});
