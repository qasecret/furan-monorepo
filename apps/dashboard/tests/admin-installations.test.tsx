/**
 * Island-level tests for the /admin/installations surface (D6(f)).
 * Mocks the dashboard's typed tRPC client so we can drive the table +
 * project Select without spinning up a real server.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const updateMutate = vi.fn();
const listInvalidate = vi.fn();

// `installations.list` data we return per-test — mutated by individual
// `test` bodies so we can vary between "empty" and "one row" scenarios.
type InstallationRow = {
  id: string;
  installationId: number;
  accountLogin: string;
  repositoryIds: number[];
  projectId: string | null;
  createdAt: Date;
};
type ProjectRow = { id: string; name: string };
let listData: { installations: InstallationRow[]; projects: ProjectRow[] } = {
  installations: [],
  projects: [],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    installations: {
      list: {
        useQuery: () => ({
          data: listData,
          isLoading: false,
          error: null,
        }),
      },
      update: {
        useMutation: (opts?: {
          onSuccess?: () => void;
          onError?: (e: Error) => void;
        }) => ({
          mutate: updateMutate,
          isPending: false,
          ...(opts ?? {}),
        }),
      },
    },
    useUtils: () => ({
      installations: { list: { invalidate: listInvalidate } },
    }),
  },
}));

import { InstallationsTable } from "../src/app/(protected)/admin/(area)/installations/_components/installations-table";

const INSTALL_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID_A = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID_B = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  updateMutate.mockReset();
  listInvalidate.mockReset();
  listData = { installations: [], projects: [] };
});

afterEach(() => {
  cleanup();
});

describe("InstallationsTable", () => {
  test("renders the empty state when installations.list returns no rows", () => {
    listData = { installations: [], projects: [] };
    render(<InstallationsTable />);
    expect(screen.getByTestId("installations-empty")).toBeDefined();
  });

  test("renders one row per installation with account, installation_id, and repo count", () => {
    listData = {
      installations: [
        {
          id: INSTALL_ID,
          installationId: 4242,
          accountLogin: "acme-co",
          repositoryIds: [1, 2, 3, 4],
          projectId: null,
          createdAt: new Date("2026-05-01T00:00:00Z"),
        },
      ],
      projects: [
        { id: PROJECT_ID_A, name: "alpha" },
        { id: PROJECT_ID_B, name: "beta" },
      ],
    };
    render(<InstallationsTable />);
    const row = screen.getByTestId(`install-row-${INSTALL_ID}`);
    expect(row).toBeDefined();
    const cells = row.querySelectorAll("td");
    expect(cells[0]!.textContent).toBe("acme-co");
    expect(cells[1]!.textContent).toBe("4242");
    // repository_ids.length rendered as the Repos column
    expect(cells[2]!.textContent).toBe("4");
    // The select trigger is present
    expect(
      screen.getByTestId(`install-project-select-${INSTALL_ID}`),
    ).toBeDefined();
  });

  test("selecting a project from the row Select fires installations.update with the right payload", async () => {
    listData = {
      installations: [
        {
          id: INSTALL_ID,
          installationId: 4242,
          accountLogin: "acme-co",
          repositoryIds: [1],
          projectId: null,
          createdAt: new Date("2026-05-01T00:00:00Z"),
        },
      ],
      projects: [
        { id: PROJECT_ID_A, name: "alpha" },
        { id: PROJECT_ID_B, name: "beta" },
      ],
    };
    render(<InstallationsTable />);

    // Open the Radix Select via its trigger (mirrors the change-role-cell
    // test pattern in admin-members.test.tsx).
    fireEvent.click(screen.getByTestId(`install-project-select-${INSTALL_ID}`));
    const betaOption = await screen.findByRole("option", { name: /beta/ });
    fireEvent.click(betaOption);

    await waitFor(() => {
      expect(updateMutate).toHaveBeenCalledTimes(1);
    });
    expect(updateMutate).toHaveBeenCalledWith({
      id: INSTALL_ID,
      projectId: PROJECT_ID_B,
    });
  });

  test("selecting '(unassigned)' fires installations.update with projectId: null", async () => {
    listData = {
      installations: [
        {
          id: INSTALL_ID,
          installationId: 4242,
          accountLogin: "acme-co",
          repositoryIds: [1],
          // Pre-linked so "(unassigned)" is a meaningful change.
          projectId: PROJECT_ID_A,
          createdAt: new Date("2026-05-01T00:00:00Z"),
        },
      ],
      projects: [
        { id: PROJECT_ID_A, name: "alpha" },
        { id: PROJECT_ID_B, name: "beta" },
      ],
    };
    render(<InstallationsTable />);

    fireEvent.click(screen.getByTestId(`install-project-select-${INSTALL_ID}`));
    const unassignedOption = await screen.findByRole("option", {
      name: /unassigned/,
    });
    fireEvent.click(unassignedOption);

    await waitFor(() => {
      expect(updateMutate).toHaveBeenCalledTimes(1);
    });
    expect(updateMutate).toHaveBeenCalledWith({
      id: INSTALL_ID,
      projectId: null,
    });
  });
});
