/**
 * Island-level tests for the /admin/projects/[projectId]/members surface.
 * Mocks the dashboard's typed tRPC client so we can drive the table, add
 * dialog, and remove confirm without spinning up a real server.
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

const addMutate = vi.fn();
const removeMutate = vi.fn();
const listInvalidate = vi.fn();

vi.mock("@/lib/trpc", () => ({
  trpc: {
    members: {
      list: {
        useQuery: (_input: { projectId: string }) => ({
          data: [
            {
              id: "m1",
              userId: "11111111-1111-4111-8111-111111111111",
              createdAt: new Date("2026-05-01T00:00:00Z"),
              email: "alice@x.test",
              role: "editor",
            },
            {
              id: "m2",
              userId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-02T00:00:00Z"),
              email: "bob@x.test",
              role: "editor",
            },
          ],
          isLoading: false,
          error: null,
        }),
      },
      add: {
        useMutation: (opts?: {
          onSuccess?: () => void;
          onError?: (e: Error) => void;
        }) => ({
          mutate: addMutate,
          isPending: false,
          ...(opts ?? {}),
        }),
      },
      remove: {
        useMutation: (opts?: {
          onSuccess?: () => void;
          onError?: (e: Error) => void;
        }) => ({
          mutate: removeMutate,
          isPending: false,
          ...(opts ?? {}),
        }),
      },
    },
    useUtils: () => ({
      members: { list: { invalidate: listInvalidate } },
    }),
  },
}));

import { AddMemberDialog } from "../src/app/(protected)/admin/projects/[projectId]/members/_components/add-member-dialog";
import { ProjectMembersTable } from "../src/app/(protected)/admin/projects/[projectId]/members/_components/project-members-table";
import { RemoveMemberButton } from "../src/app/(protected)/admin/projects/[projectId]/members/_components/remove-member-button";
import { ROLE_STYLE } from "../src/lib/role-style";

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  addMutate.mockReset();
  removeMutate.mockReset();
  listInvalidate.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ProjectMembersTable", () => {
  test("renders rows for each member returned by trpc.members.list", () => {
    render(<ProjectMembersTable projectId={PROJECT_ID} />);
    expect(
      screen.getByTestId("member-row-11111111-1111-4111-8111-111111111111"),
    ).toBeDefined();
    expect(
      screen.getByTestId("member-row-22222222-2222-4222-8222-222222222222"),
    ).toBeDefined();
    expect(screen.getByText("alice@x.test")).toBeDefined();
    expect(screen.getByText("bob@x.test")).toBeDefined();
  });

  test("role badges use the same chip classes as the account menu", () => {
    render(<ProjectMembersTable projectId={PROJECT_ID} />);
    const badges = screen.getAllByText("editor");
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      for (const cls of ROLE_STYLE.editor.split(" ")) {
        expect(badge.className).toContain(cls);
      }
      // The Badge primitive's neutral fill must not survive the merge.
      expect(badge.className).not.toContain("bg-muted");
    }
  });
});

describe("AddMemberDialog", () => {
  test("submit calls trpc.members.add.mutate with { projectId, email }", async () => {
    render(<AddMemberDialog projectId={PROJECT_ID} />);
    fireEvent.click(screen.getByTestId("add-member-button"));

    const emailInput = await screen.findByTestId("add-email-input");
    fireEvent.input(emailInput, { target: { value: "carol@x.test" } });
    fireEvent.click(screen.getByTestId("submit-add"));

    await waitFor(() => {
      expect(addMutate).toHaveBeenCalledTimes(1);
    });
    expect(addMutate).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      email: "carol@x.test",
    });
  });
});

describe("RemoveMemberButton", () => {
  test("confirming the alert dialog calls trpc.members.remove.mutate with { projectId, userId }", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    render(
      <RemoveMemberButton
        projectId={PROJECT_ID}
        userId={userId}
        email="alice@x.test"
      />,
    );

    fireEvent.click(screen.getByTestId(`remove-${userId}`));
    const confirm = await screen.findByTestId(`remove-confirm-${userId}`);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(removeMutate).toHaveBeenCalledTimes(1);
    });
    expect(removeMutate).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      userId,
    });
  });
});
