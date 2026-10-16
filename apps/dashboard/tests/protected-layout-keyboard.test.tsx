import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The layout is a server component: its server-only data calls are replaced,
// and the shell and palette (their own tests) are left out, so what is under
// test is the keyboard the layout mounts.
const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireJwt: vi.fn(async () => "jwt") }));
vi.mock("@/lib/api-client", () => ({ apiGet: apiGetMock }));
vi.mock("@/app/(protected)/_components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));
vi.mock("@/components/cmdk/command-palette", () => ({
  CommandPalette: () => null,
}));
vi.mock("@/components/themed-toaster", () => ({ ThemedToaster: () => null }));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: vi.fn() }),
}));

import ProtectedLayout from "@/app/(protected)/layout";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { useCommandRegistry } from "@/lib/commands/registry";

function me(role: string) {
  apiGetMock.mockImplementation(async (path: string) =>
    path === "/users/me"
      ? {
          status: 200,
          data: {
            id: "u1",
            email: "a@x.test",
            firstName: "A",
            lastName: "B",
            role,
            defaultProjectId: null,
          },
        }
      : { status: 200, data: [] },
  );
}

async function mountLayout() {
  const tree = await ProtectedLayout({ children: <div>page</div> });
  render(tree);
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

beforeEach(() => {
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useShortcutsSheet.setState({ open: false });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  apiGetMock.mockReset();
});

describe("the protected layout's keyboard", () => {
  it("? opens the Keyboard shortcuts sheet, listing what the viewer's role may do", async () => {
    me("editor");
    await mountLayout();
    expect(screen.queryByRole("dialog")).toBeNull();

    press("?", { shiftKey: true });

    const sheet = await screen.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    const labels = within(sheet)
      .getAllByRole("listitem")
      .map((li) => li.firstElementChild?.textContent);
    // An editor: undo and Go to Batches, but not the admin pages.
    expect(labels).toEqual(
      expect.arrayContaining(["Undo last review action", "Go to Batches"]),
    );
    expect(labels).not.toContain("Go to Analytics");
  });

  it("lists the admin pages for an admin", async () => {
    me("admin");
    await mountLayout();
    press("?", { shiftKey: true });
    const sheet = await screen.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    const labels = within(sheet)
      .getAllByRole("listitem")
      .map((li) => li.firstElementChild?.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["Go to Analytics", "Go to Projects"]),
    );
  });
});
