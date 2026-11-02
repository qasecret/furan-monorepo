// @vitest-environment node
// The server render, where `window` is undefined: CommandRoleProvider writes
// its registry store only on the client, so anything reading that store
// renders the guest branch on the server (final review, Important 1).
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: null,
    currentProject: null,
    projects: [],
  }),
}));

import { NoCurrentProject } from "@/app/(protected)/_components/no-current-project";
import { ConnectSdkCard } from "@/components/onboarding/connect-sdk-card";
import { CommandRoleProvider } from "@/lib/commands/registry";

describe("first-run states in the server render", () => {
  test("an admin with no project gets the create state, not 'ask an admin'", () => {
    const html = renderToString(
      <CommandRoleProvider role="admin">
        <NoCurrentProject />
      </CommandRoleProvider>,
    );
    expect(html).toContain("Create your first project");
    expect(html).not.toContain("No project assigned");
  });

  test("the card's token link is the admin's from the first render", () => {
    const html = renderToString(
      <CommandRoleProvider role="owner">
        <ConnectSdkCard projectId="p1" />
      </CommandRoleProvider>,
    );
    expect(html).toContain('href="/admin/api-keys"');
    expect(html).not.toContain("Ask an admin for an API token.");
  });
});
