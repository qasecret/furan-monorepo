/**
 * Component tests for the cross-branch baseline merge panel.
 * Mocks tRPC + sonner + next/navigation so we can assert the panel's
 * select-pair → mutation → router.push behavior without a live api.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { toastSuccess, toastError, toastInfo, routerPush, mergeMutate } =
  vi.hoisted(() => ({
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
    routerPush: vi.fn(),
    mergeMutate: vi.fn(),
  }));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError, info: toastInfo },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    refresh: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

let lastMutationOpts: {
  onSuccess?: (r: unknown) => void;
  onError?: (e: { message: string }) => void;
} | null = null;
let listBranchesData: string[] = [];

vi.mock("@/lib/trpc", () => ({
  trpc: {
    projects: {
      listBranches: {
        useQuery: () => ({ data: listBranchesData }),
      },
      mergeBranchBaselines: {
        useMutation: (opts?: {
          onSuccess?: (r: unknown) => void;
          onError?: (e: { message: string }) => void;
        }) => {
          lastMutationOpts = opts ?? null;
          return {
            mutate: mergeMutate,
            isPending: false,
          };
        },
      },
    },
  },
}));

import { MergeBaselinesPanel } from "../src/app/(protected)/projects/[projectId]/variations/_components/merge-baselines-panel";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  listBranchesData = ["feature/colors", "main", "feature/checkout"];
  vi.clearAllMocks();
  lastMutationOpts = null;
});
afterEach(() => {
  cleanup();
});

describe("MergeBaselinesPanel", () => {
  test("disables submit until both branches are picked + differ", async () => {
    render(<MergeBaselinesPanel projectId={PROJECT_ID} userRole="editor" />);

    const submit = screen.getByTestId(
      "merge-baselines-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Select only fromBranch — still disabled.
    fireEvent.click(screen.getByTestId("merge-from-branch"));
    fireEvent.click(screen.getByRole("option", { name: "feature/colors" }));
    expect(submit.disabled).toBe(true);

    // Select toBranch same as fromBranch — still disabled, shows error hint.
    fireEvent.click(screen.getByTestId("merge-to-branch"));
    fireEvent.click(screen.getByRole("option", { name: "feature/colors" }));
    expect(submit.disabled).toBe(true);
    expect(
      screen.getByText(/Source and destination branches must differ\./),
    ).toBeDefined();

    // Now pick a different toBranch — enabled.
    fireEvent.click(screen.getByTestId("merge-to-branch"));
    fireEvent.click(screen.getByRole("option", { name: "main" }));
    expect(submit.disabled).toBe(false);
  });

  test("submit calls projects.mergeBranchBaselines and routes to the build on success", async () => {
    render(<MergeBaselinesPanel projectId={PROJECT_ID} userRole="editor" />);

    fireEvent.click(screen.getByTestId("merge-from-branch"));
    fireEvent.click(screen.getByRole("option", { name: "feature/colors" }));
    fireEvent.click(screen.getByTestId("merge-to-branch"));
    fireEvent.click(screen.getByRole("option", { name: "main" }));
    fireEvent.click(screen.getByTestId("merge-baselines-submit"));

    await waitFor(() => {
      expect(mergeMutate).toHaveBeenCalledTimes(1);
    });
    expect(mergeMutate).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      fromBranch: "feature/colors",
      toBranch: "main",
    });

    // Drive the success callback the panel wired up.
    lastMutationOpts?.onSuccess?.({
      buildId: "build-uuid-abc",
      runCount: 5,
      skippedCount: 0,
      fromBranch: "feature/colors",
      toBranch: "main",
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("5 variations queued"),
    );
    expect(routerPush).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/builds/build-uuid-abc`,
    );
  });

  test("runCount=0 surfaces an info toast and does NOT navigate", async () => {
    render(<MergeBaselinesPanel projectId={PROJECT_ID} userRole="editor" />);

    fireEvent.click(screen.getByTestId("merge-from-branch"));
    fireEvent.click(screen.getByRole("option", { name: "feature/colors" }));
    fireEvent.click(screen.getByTestId("merge-to-branch"));
    fireEvent.click(screen.getByRole("option", { name: "main" }));
    fireEvent.click(screen.getByTestId("merge-baselines-submit"));

    lastMutationOpts?.onSuccess?.({
      buildId: "build-uuid-abc",
      runCount: 0,
      skippedCount: 0,
      fromBranch: "feature/colors",
      toBranch: "main",
    });
    expect(toastInfo).toHaveBeenCalledWith(
      expect.stringContaining("nothing to promote"),
    );
    expect(routerPush).not.toHaveBeenCalled();
  });

  test("guest role disables both selects + the submit", () => {
    render(<MergeBaselinesPanel projectId={PROJECT_ID} userRole="guest" />);
    expect(
      (screen.getByTestId("merge-from-branch") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("merge-to-branch") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("merge-baselines-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
