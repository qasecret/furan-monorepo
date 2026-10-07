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
let updateOpts: { onError?: (e: { message: string }) => void } | undefined;

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
  data: (typeof baseProject & { hasVlmApiKey?: boolean }) | undefined;
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
        }) => {
          updateOpts = opts;
          return {
            // Mirror tRPC: a successful mutate fires onSuccess. Keep
            // updateMutate as the spy the "submit calls mutate" test asserts
            // on, then invoke the form's onSuccess (toast + dirty reset).
            mutate: (vars: unknown) => {
              updateMutate(vars);
              opts?.onSuccess?.();
            },
            isPending: false,
            ...(opts ?? {}),
          };
        },
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

  test("submitting with an invalid value on an inactive tab switches back to it", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="editor" />);

    // The "Basics" tab is active by default; its name field is visible.
    const nameInput = await screen.findByTestId("name-input");
    // Make it invalid (name is `.min(1, "Required")`).
    fireEvent.input(nameInput, { target: { value: "" } });

    // Switch to the Diff tab so Basics content is hidden.
    const diffTab = screen.getByRole("button", { name: /diff/i });
    fireEvent.click(diffTab);

    // Submit — validation fails, so the form should switch back to Basics.
    fireEvent.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      // The basics tab should be active again (its content visible).
      const nameField = screen.getByTestId("name-input");
      expect(nameField.closest('[class*="hidden"]')).toBeNull();
    });
    // The invalid submit never reached the mutation.
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

// ADR-060: the Visual-AI API key is write-only (the API never returns it;
// `hasVlmApiKey` says whether one is set) and only admins may change the
// provider / endpoint / key. The key must never appear in the JSON textarea.
describe("ProjectSettingsForm — Visual-AI provider settings (ADR-060)", () => {
  const vlmProject = {
    ...baseProject,
    imageComparison: "vlm" as unknown as "pixelmatch",
    imageComparisonConfig: JSON.stringify(
      { provider: "anthropic", model: "claude-x", temperature: 0.1 },
      null,
      2,
    ),
    hasVlmApiKey: true,
  };

  beforeEach(() => {
    getByIdReturn.data = vlmProject;
  });
  afterEach(() => {
    getByIdReturn.data = baseProject;
  });

  const sent = () =>
    updateMutate.mock.calls.at(-1)![0] as Record<string, unknown> & {
      imageComparisonConfig: string;
    };
  const sentConfig = () =>
    JSON.parse(sent().imageComparisonConfig) as Record<string, unknown>;
  const textarea = () =>
    screen.getByTestId("image-config-textarea") as HTMLTextAreaElement;

  test("admin: the key is never pre-filled; the panel says one is configured", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="admin" />);
    const key = (await screen.findByTestId(
      "vlm-api-key-input",
    )) as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.placeholder).toMatch(/replace/i);
    // Keep the browser from autofilling the user's login password here.
    expect(key.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByTestId("vlm-api-key-status").textContent).toMatch(
      /configured/i,
    );
  });

  test("admin: a typed key is sent on save but never shown in the JSON textarea", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="admin" />);
    const key = await screen.findByTestId("vlm-api-key-input");
    fireEvent.change(key, { target: { value: "sk-typed-new-key" } });
    expect(textarea().value).not.toContain("sk-typed-new-key");

    fireEvent.click(screen.getByTestId("save-button"));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(sentConfig().apiKey).toBe("sk-typed-new-key");
    expect(sentConfig().provider).toBe("anthropic");
    // Form-only fields never reach the API.
    expect(sent()).not.toHaveProperty("vlmApiKey");
    expect(sent()).not.toHaveProperty("vlmClearApiKey");
  });

  test("admin: saving without touching the key omits apiKey (the server keeps it)", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="admin" />);
    const nameInput = await screen.findByTestId("name-input");
    fireEvent.input(nameInput, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("save-button"));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(sentConfig()).not.toHaveProperty("apiKey");
  });

  test("admin: Remove key sends an explicit clear; Undo cancels it", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="admin" />);
    fireEvent.click(await screen.findByTestId("vlm-api-key-remove"));
    expect(screen.getByTestId("vlm-api-key-status").textContent).toMatch(
      /removed when you save/i,
    );
    fireEvent.click(screen.getByTestId("vlm-api-key-undo-remove"));
    expect(screen.getByTestId("vlm-api-key-status").textContent).toMatch(
      /configured/i,
    );

    fireEvent.click(screen.getByTestId("vlm-api-key-remove"));
    fireEvent.click(screen.getByTestId("save-button"));
    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(sentConfig().apiKey).toBe("");
  });

  test("admin: no Remove button when no key is configured", async () => {
    getByIdReturn.data = { ...vlmProject, hasVlmApiKey: false };
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="admin" />);
    const key = (await screen.findByTestId(
      "vlm-api-key-input",
    )) as HTMLInputElement;
    expect(key.placeholder).not.toMatch(/replace/i);
    expect(screen.queryByTestId("vlm-api-key-remove")).toBeNull();
    expect(screen.getByTestId("vlm-api-key-status").textContent).toMatch(
      /no key/i,
    );
  });

  test("editor: provider + key controls are disabled with an explanation; other VLM knobs stay editable", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="editor" />);
    const provider = (await screen.findByTestId(
      "vlm-provider-select",
    )) as HTMLButtonElement;
    expect(provider.disabled).toBe(true);
    expect(
      (screen.getByTestId("vlm-api-key-input") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId("vlm-api-key-remove")).toBeNull();
    expect(
      screen.getByTestId("vlm-provider-admin-only-hint").textContent,
    ).toMatch(/only admins/i);
    expect(
      (screen.getByTestId("vlm-model-input") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  test("shows the server's admin-only rejection as readable text", async () => {
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="editor" />);
    await screen.findByTestId("vlm-provider-select");
    updateOpts?.onError?.({ message: "vlm_provider_settings_admin_only" });
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/only admins can change the ai provider/i),
    );
  });

  test("rejects a JSON config that isn't an object before calling the API", async () => {
    getByIdReturn.data = baseProject;
    render(<ProjectSettingsForm projectId={PROJECT_ID} userRole="admin" />);
    await screen.findByTestId("image-config-textarea");
    fireEvent.change(textarea(), { target: { value: "[1, 2]" } });
    fireEvent.click(screen.getByTestId("save-button"));
    expect(
      await screen.findByText("Must be a JSON object or empty"),
    ).toBeTruthy();
    expect(updateMutate).not.toHaveBeenCalled();
  });
});
