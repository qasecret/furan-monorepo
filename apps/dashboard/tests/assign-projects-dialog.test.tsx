/**
 * Island-level tests for AssignProjectsDialog (U8 — single-project tenancy).
 *
 * Mocks the dashboard's typed tRPC client so we can drive the membership
 * toggles + default selector and assert the exact setUserProjects payload
 * without a real server. No jest-dom — plain matchers + mutate.mock.calls.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// AssignProjectsDialog calls router.refresh() on success.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const setProjectsMutate = vi.fn();
// The user already belongs to p1 + p2 (drives the pre-checked boxes).
const MEMBERSHIP = ["p1", "p2"];

// Mutable so individual tests can exercise the loading / error gate.
let membershipResult: {
  data: string[] | undefined;
  isLoading: boolean;
  isError: boolean;
} = { data: MEMBERSHIP, isLoading: false, isError: false };

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      members: { listUserProjects: { invalidate: vi.fn() } },
    }),
    members: {
      listUserProjects: {
        useQuery: (_input: { userId: string }, _opts?: unknown) =>
          membershipResult,
      },
      setUserProjects: {
        useMutation: (opts?: {
          onSuccess?: () => void;
          onError?: (e: Error) => void;
        }) => ({
          mutate: setProjectsMutate,
          isPending: false,
          ...(opts ?? {}),
        }),
      },
    },
  },
}));

import { AssignProjectsDialog } from "../src/app/(protected)/admin/(area)/members/_components/assign-projects-dialog";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const ALL_PROJECTS = [
  { id: "p1", name: "Alpha" },
  { id: "p2", name: "Beta" },
  { id: "p3", name: "Gamma" },
];

function isOn(el: HTMLElement): boolean {
  return el.getAttribute("aria-checked") === "true";
}

beforeEach(() => {
  setProjectsMutate.mockReset();
  membershipResult = { data: MEMBERSHIP, isLoading: false, isError: false };
});

afterEach(() => {
  cleanup();
});

describe("AssignProjectsDialog", () => {
  test("opening pre-checks the boxes from listUserProjects", async () => {
    const user = userEvent.setup();
    render(
      <AssignProjectsDialog
        userId={USER_ID}
        userEmail="alice@x.test"
        defaultProjectId="p1"
        allProjects={ALL_PROJECTS}
      />,
    );

    await user.click(screen.getByTestId("assign-projects-trigger"));

    expect(isOn(screen.getByTestId("assign-project-p1"))).toBe(true);
    expect(isOn(screen.getByTestId("assign-project-p2"))).toBe(true);
    expect(isOn(screen.getByTestId("assign-project-p3"))).toBe(false);
  });

  test("the default selector only offers checked projects (+ None)", async () => {
    const user = userEvent.setup();
    render(
      <AssignProjectsDialog
        userId={USER_ID}
        userEmail="alice@x.test"
        defaultProjectId="p1"
        allProjects={ALL_PROJECTS}
      />,
    );

    await user.click(screen.getByTestId("assign-projects-trigger"));
    await user.click(screen.getByTestId("assign-default-select"));

    // p1 + p2 are checked → offered; p3 is unchecked → absent.
    expect(screen.getByRole("option", { name: "None" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Alpha" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Beta" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "Gamma" })).toBeNull();
  });

  test("toggling a box + picking a default + Save sends the exact payload", async () => {
    const user = userEvent.setup();
    render(
      <AssignProjectsDialog
        userId={USER_ID}
        userEmail="alice@x.test"
        defaultProjectId={null}
        allProjects={ALL_PROJECTS}
      />,
    );

    await user.click(screen.getByTestId("assign-projects-trigger"));

    // Add p3 to the membership set (p1 + p2 already on).
    await user.click(screen.getByTestId("assign-project-p3"));

    // Now p3 should be selectable as the default.
    await user.click(screen.getByTestId("assign-default-select"));
    await user.click(screen.getByRole("option", { name: "Gamma" }));

    await user.click(screen.getByTestId("assign-projects-save"));

    expect(setProjectsMutate).toHaveBeenCalledTimes(1);
    const [payload] = setProjectsMutate.mock.calls[0] as [
      {
        userId: string;
        projectIds: string[];
        defaultProjectId: string | null;
      },
    ];
    expect(payload.userId).toBe(USER_ID);
    expect([...payload.projectIds].sort()).toEqual(["p1", "p2", "p3"]);
    expect(payload.defaultProjectId).toBe("p3");
  });

  test("unchecking the current default resets it to null in the payload", async () => {
    const user = userEvent.setup();
    render(
      <AssignProjectsDialog
        userId={USER_ID}
        userEmail="alice@x.test"
        defaultProjectId="p1"
        allProjects={ALL_PROJECTS}
      />,
    );

    await user.click(screen.getByTestId("assign-projects-trigger"));

    // p1 is the default; unchecking it must drop the default.
    await user.click(screen.getByTestId("assign-project-p1"));
    await user.click(screen.getByTestId("assign-projects-save"));

    expect(setProjectsMutate).toHaveBeenCalledTimes(1);
    const [payload] = setProjectsMutate.mock.calls[0] as [
      {
        projectIds: string[];
        defaultProjectId: string | null;
      },
    ];
    expect([...payload.projectIds].sort()).toEqual(["p2"]);
    expect(payload.defaultProjectId).toBeNull();
  });

  test("Save is disabled while memberships are still loading", async () => {
    membershipResult = { data: undefined, isLoading: true, isError: false };
    const user = userEvent.setup();
    render(
      <AssignProjectsDialog
        userId={USER_ID}
        userEmail="alice@x.test"
        defaultProjectId={null}
        allProjects={ALL_PROJECTS}
      />,
    );

    await user.click(screen.getByTestId("assign-projects-trigger"));

    expect(screen.getByTestId("assign-loading")).toBeDefined();
    expect(
      (screen.getByTestId("assign-projects-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
