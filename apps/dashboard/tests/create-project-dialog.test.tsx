/**
 * Island-level tests for CreateProjectDialog. Mocks global fetch + next/navigation's
 * useRouter, mirrors the pattern from admin-members.test.tsx (which covers
 * CreateUserDialog) and account-tokens.test.tsx (CreateTokenDialog).
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { toastError, routerPush } = vi.hoisted(() => ({
  toastError: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: toastError },
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

import { CreateProjectDialog } from "../src/app/(protected)/projects/_components/create-project-dialog";

type FetchCall = { url: string; init?: RequestInit };

function setupFetch(
  handler?: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (handler) return handler({ url, init });
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { calls };
}

beforeEach(() => {
  routerPush.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CreateProjectDialog", () => {
  test("renders the trigger button", () => {
    setupFetch();
    render(<CreateProjectDialog />);
    expect(screen.getByTestId("create-project-button")).toBeDefined();
  });

  test("opens the dialog when the trigger is clicked", () => {
    setupFetch();
    render(<CreateProjectDialog />);
    fireEvent.click(screen.getByTestId("create-project-button"));
    expect(screen.getByTestId("create-project-form")).toBeDefined();
    expect(screen.getByTestId("project-name-input")).toBeDefined();
    expect(screen.getByTestId("project-branch-input")).toBeDefined();
  });

  test("rejects an empty name with an inline field error", async () => {
    setupFetch();
    render(<CreateProjectDialog />);
    fireEvent.click(screen.getByTestId("create-project-button"));
    fireEvent.click(screen.getByTestId("submit-create-project"));
    await waitFor(() => {
      expect(screen.getByText(/Required/i)).toBeDefined();
    });
  });

  test("submits with name only — mainBranchName omitted from body", async () => {
    const { calls } = setupFetch(({ url }) => {
      if (url.endsWith("/projects")) {
        return new Response(JSON.stringify({ id: "new-id-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });
    render(<CreateProjectDialog />);
    fireEvent.click(screen.getByTestId("create-project-button"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "my-app" },
    });
    fireEvent.click(screen.getByTestId("submit-create-project"));
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith("/projects/new-id-1");
    });
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ name: "my-app" });
  });

  test("submits with mainBranchName override", async () => {
    const { calls } = setupFetch(
      () =>
        new Response(JSON.stringify({ id: "new-id-2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    render(<CreateProjectDialog />);
    fireEvent.click(screen.getByTestId("create-project-button"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "my-app" },
    });
    fireEvent.change(screen.getByTestId("project-branch-input"), {
      target: { value: "trunk" },
    });
    fireEvent.click(screen.getByTestId("submit-create-project"));
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalled();
    });
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ name: "my-app", mainBranchName: "trunk" });
  });

  test("409 surfaces an inline name-field error", async () => {
    setupFetch(
      () =>
        new Response(JSON.stringify({ code: "project_name_taken" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    );
    render(<CreateProjectDialog />);
    fireEvent.click(screen.getByTestId("create-project-button"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "dup" },
    });
    fireEvent.click(screen.getByTestId("submit-create-project"));
    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeDefined();
    });
    expect(routerPush).not.toHaveBeenCalled();
  });

  test("403 surfaces an admin-only toast", async () => {
    setupFetch(
      () =>
        new Response(JSON.stringify({ code: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    );
    render(<CreateProjectDialog />);
    fireEvent.click(screen.getByTestId("create-project-button"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("submit-create-project"));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/admin/i));
    });
  });

  test("5xx surfaces a generic toast", async () => {
    setupFetch(
      () =>
        new Response(JSON.stringify({ code: "boom" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    );
    render(<CreateProjectDialog />);
    fireEvent.click(screen.getByTestId("create-project-button"));
    fireEvent.change(screen.getByTestId("project-name-input"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("submit-create-project"));
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
  });
});
