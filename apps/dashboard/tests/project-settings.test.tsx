/**
 * Island-level tests for the /projects/[projectId]/settings surface.
 * Mocks the dashboard's typed tRPC client so we can drive the form
 * without a real backend.
 *
 * Spec D4 acceptance: form pre-populates, Save submits the update
 * mutation with the form values, and guests see a disabled Save with
 * a tooltip explanation.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const updateMutate = vi.fn();
const getByIdInvalidate = vi.fn();

const baseProject = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Test project",
  mainBranchName: "main",
  diffThreshold: 0.001,
  autoApproveFeature: false,
  // Differs from useForm's default "odiff" so form.reset triggers the
  // value transition that previously crashed via Radix Select firing
  // onValueChange("") before SelectItems registered.
  imageComparison: "pixelmatch" as const,
  retentionDays: 90,
  maxBuildAllowed: 100,
  maxBranchLifetime: 30,
  imageComparisonConfig: "{}",
};

const getByIdReturn: {
  data: typeof baseProject | undefined;
  isLoading: boolean;
  error: { message: string } | null;
} = {
  data: baseProject,
  isLoading: false,
  error: null,
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    projects: {
      getById: {
        useQuery: (_input: { projectId: string }) => getByIdReturn,
      },
      update: {
        useMutation: (opts?: {
          onSuccess?: () => void;
          onError?: (e: { message: string }) => void;
        }) => ({
          // Mirror tRPC: a successful mutate fires onSuccess. Keep
          // updateMutate as the spy the "submit calls mutate" test asserts
          // on, then invoke the form's onSuccess (toast + dirty reset).
          mutate: (vars: unknown) => {
            updateMutate(vars);
            opts?.onSuccess?.();
          },
          isPending: false,
          ...(opts ?? {}),
        }),
      },
    },
    useUtils: () => ({
      projects: { getById: { invalidate: getByIdInvalidate } },
    }),
  },
}));

import { ProjectSettingsForm } from "../src/app/(protected)/projects/[projectId]/settings/_components/project-settings-form";

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  updateMutate.mockReset();
  getByIdInvalidate.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ProjectSettingsForm", () => {
  test("pre-populates inputs from the trpc.projects.getById response", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="editor" />);
    const nameInput = (await screen.findByTestId(
      "name-input",
    )) as HTMLInputElement;
    const mainBranchInput = screen.getByTestId(
      "main-branch-input",
    ) as HTMLInputElement;
    const retentionInput = screen.getByTestId(
      "retention-input",
    ) as HTMLInputElement;
    const maxBuildInput = screen.getByTestId(
      "max-build-input",
    ) as HTMLInputElement;
    const maxBranchInput = screen.getByTestId(
      "max-branch-input",
    ) as HTMLInputElement;
    const configTextarea = screen.getByTestId(
      "image-config-textarea",
    ) as HTMLTextAreaElement;

    expect(nameInput.value).toBe("Test project");
    expect(mainBranchInput.value).toBe("main");
    expect(retentionInput.value).toBe("90");
    expect(maxBuildInput.value).toBe("100");
    expect(maxBranchInput.value).toBe("30");
    expect(configTextarea.value).toBe("{}");
  });

  test("submit calls trpc.projects.update.mutate with edited values", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="editor" />);

    const nameInput = await screen.findByTestId("name-input");
    fireEvent.input(nameInput, { target: { value: "Renamed project" } });

    const retentionInput = screen.getByTestId("retention-input");
    fireEvent.input(retentionInput, { target: { value: "180" } });

    fireEvent.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(updateMutate).toHaveBeenCalledTimes(1);
    });
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        name: "Renamed project",
        mainBranchName: "main",
        retentionDays: 180,
        maxBuildAllowed: 100,
        maxBranchLifetime: 30,
        diffThreshold: 0.001,
        autoApproveFeature: false,
        imageComparisonConfig: "{}",
      }),
    );
  });

  test("renders the engine knobs panel for the loaded imageComparison value", async () => {
    // Regression for the Radix Select v2 race: when the project's
    // imageComparison ("pixelmatch" here) differs from the form's
    // default ("odiff"), form.reset causes the controlled Select to
    // re-render, and Radix's hidden form-control <select> fires
    // onValueChange("") before SelectItems register. The form filters
    // that empty string and EngineKnobsEditor short-circuits, so the
    // pixelmatch knobs panel must still render.
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="editor" />);
    expect(await screen.findByTestId("engine-knobs-pixelmatch")).toBeTruthy();
    expect(screen.getByTestId("engine-pixelmatch-threshold")).toBeTruthy();
  });

  test("guest sees Save button disabled with an explanatory tooltip", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="guest" />);
    const save = (await screen.findByTestId(
      "save-button",
    )) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe("Guests can't modify project settings");

    fireEvent.click(save);
    // Disabled buttons should not invoke the mutation.
    expect(updateMutate).not.toHaveBeenCalled();
  });

  test("Save shows a success toast on a valid submit", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="editor" />);

    const nameInput = await screen.findByTestId("name-input");
    fireEvent.input(nameInput, { target: { value: "Renamed project" } });

    fireEvent.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(updateMutate).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
  });

  test("submitting with an invalid value in a collapsed section auto-expands it", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="editor" />);

    // The "Basics" section is open by default; its name field is visible.
    const nameInput = await screen.findByTestId("name-input");
    // Make it invalid (name is `.min(1, "Required")`).
    fireEvent.input(nameInput, { target: { value: "" } });

    // Collapse the Basics section via its header button.
    const basicsHeader = screen.getByRole("button", { name: /basics/i });
    expect(basicsHeader.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(basicsHeader);
    expect(basicsHeader.getAttribute("aria-expanded")).toBe("false");
    // Collapsed: the name field is no longer rendered.
    expect(screen.queryByTestId("name-input")).toBeNull();

    // Submit — validation fails, so the invalid section must re-expand.
    fireEvent.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: /basics/i })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    });
    // Its content (the name field) is visible again.
    expect(screen.getByTestId("name-input")).toBeTruthy();
    // The invalid submit never reached the mutation.
    expect(updateMutate).not.toHaveBeenCalled();
  });
});
