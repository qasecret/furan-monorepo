import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const mutate = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    account: {
      setDefaultProject: {
        useMutation: () => ({ mutate, isPending: false }),
      },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PreferencesForm } from "@/app/(protected)/account/preferences/_components/preferences-form";

afterEach(() => {
  cleanup();
  mutate.mockClear();
});

const projects = [
  { id: "a", name: "alpha" },
  { id: "b", name: "beta" },
];

test("Save is disabled until the selection changes, then persists", async () => {
  const user = userEvent.setup();
  render(<PreferencesForm projects={projects} currentDefaultId="a" />);
  const saveBtn = screen.getByTestId("preferences-save") as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(true);
  await user.click(screen.getByTestId("preferences-select"));
  await user.click(screen.getByRole("option", { name: "beta" }));
  expect(saveBtn.disabled).toBe(false);
  await user.click(saveBtn);
  expect(mutate).toHaveBeenCalledWith({ projectId: "b" });
});

test("zero projects shows the empty note (no Select)", () => {
  render(<PreferencesForm projects={[]} currentDefaultId={null} />);
  expect(screen.getByTestId("preferences-no-projects")).toBeDefined();
  expect(screen.queryByTestId("preferences-select")).toBeNull();
});
