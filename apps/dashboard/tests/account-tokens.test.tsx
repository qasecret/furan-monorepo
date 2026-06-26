/**
 * Island-level tests for the /account/tokens surface. We render the client
 * components directly (CreateTokenDialog, DeleteTokenButton, TokensTable) and
 * mock the global fetch, mirroring the pattern from admin-members.test.tsx.
 *
 * The highest-stakes invariant under test is the show-once flow: the raw
 * `furan_pat_*` value must appear in the DOM exactly once, must be removed
 * from in-memory state when the dialog closes, and MUST NEVER be persisted
 * to localStorage / sessionStorage (spec D3.6).
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

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: routerRefresh,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

import { CreateTokenDialog } from "../src/app/(protected)/account/tokens/_components/create-token-dialog";
import { DeleteTokenButton } from "../src/app/(protected)/account/tokens/_components/delete-token-button";
import { TokensTable } from "../src/app/(protected)/account/tokens/_components/tokens-table";

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

const RAW_TOKEN = "furan_pat_test_abc123def456ghi789";

beforeEach(() => {
  routerRefresh.mockReset();
  // Each test gets a fresh clipboard mock; some tests overwrite this.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
    writable: true,
  });
  // Clear any storage leakage from prior tests.
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* jsdom may not implement; ignore */
  }
});

afterEach(() => {
  cleanup();
});

describe("TokensTable", () => {
  test("renders one row per token with label, created-at and last-used", () => {
    setupFetch();
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const twoHrAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const tokens = [
      {
        id: "tok-1",
        label: "CI — main",
        createdAt: fiveMinAgo,
        lastUsedAt: twoHrAgo,
      },
      {
        id: "tok-2",
        label: "Laptop",
        createdAt: fiveMinAgo,
        lastUsedAt: null,
      },
    ];
    render(<TokensTable initialTokens={tokens} />);

    expect(screen.getByTestId("token-row-tok-1")).toBeDefined();
    expect(screen.getByTestId("token-row-tok-2")).toBeDefined();
    expect(screen.getByText("CI — main")).toBeDefined();
    expect(screen.getByText("Laptop")).toBeDefined();
    // "Never" label for the never-used token
    const row2 = screen.getByTestId("token-row-tok-2");
    expect(row2.textContent).toContain("Never");
  });

  test("renders an empty state when there are no tokens", () => {
    setupFetch();
    render(<TokensTable initialTokens={[]} />);
    expect(screen.getByText(/no tokens yet/i)).toBeDefined();
  });
});

describe("CreateTokenDialog", () => {
  test("submits the label and transitions to phase 2 with the raw token", async () => {
    const { calls } = setupFetch(({ url, init }) => {
      if (url.endsWith("/account/tokens") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "tok-new",
            label: "CI — main",
            createdAt: new Date().toISOString(),
            token: RAW_TOKEN,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    render(<CreateTokenDialog />);
    fireEvent.click(screen.getByTestId("create-token-button"));

    const labelInput = await screen.findByTestId("label-input");
    fireEvent.input(labelInput, { target: { value: "CI — main" } });
    fireEvent.click(screen.getByTestId("submit-create-token"));

    // Phase 2: raw token revealed
    const display = await screen.findByTestId("raw-token-display");
    expect(display.textContent).toBe(RAW_TOKEN);

    const post = calls.find(
      (c) => c.url.endsWith("/account/tokens") && c.init?.method === "POST",
    );
    expect(post).toBeDefined();
    expect(JSON.parse(String(post!.init?.body))).toEqual({
      label: "CI — main",
    });
  });

  test("close button is disabled until the acknowledge checkbox is checked", async () => {
    setupFetch(({ url, init }) => {
      if (url.endsWith("/account/tokens") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "tok-new",
            label: "test",
            createdAt: new Date().toISOString(),
            token: RAW_TOKEN,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    render(<CreateTokenDialog />);
    fireEvent.click(screen.getByTestId("create-token-button"));
    const labelInput = await screen.findByTestId("label-input");
    fireEvent.input(labelInput, { target: { value: "test" } });
    fireEvent.click(screen.getByTestId("submit-create-token"));

    const closeBtn = (await screen.findByTestId(
      "close-token-dialog",
    )) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);

    const checkbox = screen.getByTestId(
      "acknowledge-checkbox",
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(closeBtn.disabled).toBe(false);
  });

  test("copy button writes the raw token to navigator.clipboard", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    setupFetch(({ url, init }) => {
      if (url.endsWith("/account/tokens") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "tok-new",
            label: "test",
            createdAt: new Date().toISOString(),
            token: RAW_TOKEN,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    render(<CreateTokenDialog />);
    fireEvent.click(screen.getByTestId("create-token-button"));
    const labelInput = await screen.findByTestId("label-input");
    fireEvent.input(labelInput, { target: { value: "test" } });
    fireEvent.click(screen.getByTestId("submit-create-token"));

    const copyBtn = await screen.findByTestId("copy-token-button");
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(RAW_TOKEN);
    });
  });

  test("does not persist the raw token in localStorage/sessionStorage", async () => {
    setupFetch(({ url, init }) => {
      if (url.endsWith("/account/tokens") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "tok-new",
            label: "test",
            createdAt: new Date().toISOString(),
            token: RAW_TOKEN,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    render(<CreateTokenDialog />);
    fireEvent.click(screen.getByTestId("create-token-button"));
    const labelInput = await screen.findByTestId("label-input");
    fireEvent.input(labelInput, { target: { value: "test" } });
    fireEvent.click(screen.getByTestId("submit-create-token"));

    // Wait for phase 2 to render so the token has been handled.
    await screen.findByTestId("raw-token-display");

    // Acknowledge + close the dialog.
    fireEvent.click(screen.getByTestId("acknowledge-checkbox"));
    fireEvent.click(screen.getByTestId("close-token-dialog"));

    // Scan all storage keys for any leakage of the raw PAT prefix.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      expect(localStorage.getItem(key) ?? "").not.toMatch(/furan_pat_/);
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      expect(sessionStorage.getItem(key) ?? "").not.toMatch(/furan_pat_/);
    }

    // Also assert the raw token is no longer rendered in the DOM after close.
    expect(screen.queryByTestId("raw-token-display")).toBeNull();
  });
});

describe("DeleteTokenButton", () => {
  test("confirming the alert dialog DELETEs /account/tokens/:id", async () => {
    const { calls } = setupFetch(({ init }) => {
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("{}", { status: 200 });
    });

    const onDeleted = vi.fn();
    render(
      <DeleteTokenButton
        tokenId="tok-9"
        label="Old CI"
        onDeleted={onDeleted}
      />,
    );

    fireEvent.click(screen.getByTestId("delete-token-tok-9"));
    const confirm = await screen.findByTestId("delete-token-confirm-tok-9");
    fireEvent.click(confirm);

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(del!.url).toMatch(/\/account\/tokens\/tok-9$/);
    });
    expect(onDeleted).toHaveBeenCalled();
  });
});
