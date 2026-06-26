/**
 * Island-level tests for the /admin/members surface. We render the client
 * components directly with controlled props rather than the Server Component
 * page — this keeps tests fast and avoids stubbing the Next.js RSC pipeline.
 */
import {
  act,
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

// MembersTable now renders <AssignProjectsDialog> per row, which calls the
// typed tRPC client at mount. These rows mount with allProjects=[] so the
// dialog body is empty, but the hooks still need stubs to not crash.
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      members: { listUserProjects: { invalidate: vi.fn() } },
    }),
    members: {
      listUserProjects: {
        useQuery: () => ({ data: [], isLoading: false, isError: false }),
      },
      setUserProjects: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

const routerPush = vi.fn();
const routerRefresh = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    refresh: routerRefresh,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => currentSearchParams,
}));

import { ChangeRoleCell } from "../src/app/(protected)/admin/(area)/members/_components/change-role-cell";
import { CreateUserDialog } from "../src/app/(protected)/admin/(area)/members/_components/create-user-dialog";
import { DeactivateButton } from "../src/app/(protected)/admin/(area)/members/_components/deactivate-button";
import {
  MembersTable,
  type MemberRow,
} from "../src/app/(protected)/admin/(area)/members/_components/members-table";

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

function makeUsers(n: number): MemberRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    email: `user${i}@example.com`,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    role: i === 0 ? "admin" : "editor",
    isActive: true,
  }));
}

beforeEach(() => {
  routerPush.mockReset();
  routerRefresh.mockReset();
  currentSearchParams = new URLSearchParams();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("MembersTable", () => {
  test("renders all 25 rows when 25 users are provided", () => {
    setupFetch();
    const users = makeUsers(25);
    render(
      <MembersTable
        initialUsers={users}
        currentUserId="someone-else"
        viewerRole="admin"
        allProjects={[]}
      />,
    );
    for (const u of users) {
      expect(screen.getByTestId(`user-row-${u.id}`)).toBeDefined();
    }
  });

  test("search input debounces and pushes ?q= to the router", async () => {
    vi.useFakeTimers();
    setupFetch();
    const users = makeUsers(1);
    render(
      <MembersTable
        initialUsers={users}
        currentUserId="someone-else"
        viewerRole="admin"
        allProjects={[]}
      />,
    );

    const input = screen.getByTestId(
      "members-search-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alice" } });

    // Before debounce fires
    expect(routerPush).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(305);
    });

    expect(routerPush).toHaveBeenCalledTimes(1);
    const pushedUrl = routerPush.mock.calls[0]![0] as string;
    expect(pushedUrl).toContain("q=alice");
  });

  test("deactivate button is disabled on the current-user row", () => {
    setupFetch();
    const users = makeUsers(2);
    render(
      <MembersTable
        initialUsers={users}
        currentUserId={users[0]!.id}
        viewerRole="admin"
        allProjects={[]}
      />,
    );

    const selfBtn = screen.getByTestId(
      `deactivate-${users[0]!.id}`,
    ) as HTMLButtonElement;
    expect(selfBtn.disabled).toBe(true);
    expect(selfBtn.getAttribute("title")).toMatch(/can't deactivate/i);

    const otherBtn = screen.getByTestId(
      `deactivate-${users[1]!.id}`,
    ) as HTMLButtonElement;
    expect(otherBtn.disabled).toBe(false);
  });
});

describe("CreateUserDialog", () => {
  test("submitting valid input POSTs /users with the right payload", async () => {
    const { calls } = setupFetch(({ url, init }) => {
      if (url.endsWith("/users") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "new-id",
            email: "alice@example.com",
            role: "editor",
            isActive: true,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    render(<CreateUserDialog />);
    fireEvent.click(screen.getByTestId("create-user-button"));

    // Dialog mounts the form
    const emailInput = await screen.findByTestId("create-email");
    const passwordInput = screen.getByTestId("create-password");
    const firstNameInput = screen.getByTestId("create-first-name");
    const lastNameInput = screen.getByTestId("create-last-name");

    fireEvent.input(emailInput, {
      target: { value: "alice@example.com" },
    });
    fireEvent.input(passwordInput, { target: { value: "supersecret1" } });
    fireEvent.input(firstNameInput, { target: { value: "Alice" } });
    fireEvent.input(lastNameInput, { target: { value: "Smith" } });

    fireEvent.click(screen.getByTestId("create-submit"));

    await waitFor(() => {
      expect(
        calls.find(
          (c) => c.url.endsWith("/users") && c.init?.method === "POST",
        ),
      ).toBeDefined();
    });

    const post = calls.find(
      (c) => c.url.endsWith("/users") && c.init?.method === "POST",
    )!;
    const body = JSON.parse(String(post.init?.body));
    expect(body).toMatchObject({
      email: "alice@example.com",
      password: "supersecret1",
      firstName: "Alice",
      lastName: "Smith",
      role: "editor",
    });
  });
});

describe("ChangeRoleCell", () => {
  test("changing the select PATCHes /users/:id with { role }", async () => {
    const { calls } = setupFetch(({ init }) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: "u1", role: "admin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });

    const onChanged = vi.fn();
    render(<ChangeRoleCell userId="u1" value="editor" onChanged={onChanged} />);

    // Radix Select hides its native <select>, but exposes the trigger.
    // For an island-level test, we drive the public handler by re-rendering
    // through the trigger -> content path is brittle in jsdom. Instead we
    // simulate the same effect by dispatching the onValueChange via the
    // underlying state: open the trigger and click an option.
    fireEvent.click(screen.getByTestId("role-cell-u1"));

    // The option lives in a portal; findByRole works once it's mounted.
    const adminOption = await screen.findByRole("option", { name: "Admin" });
    fireEvent.click(adminOption);

    // Granting admin is privileged → an explicit confirmation gate fires first.
    const confirmBtn = await screen.findByRole("button", { name: /confirm/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === "PATCH");
      expect(patch).toBeDefined();
      expect(patch!.url).toMatch(/\/users\/u1$/);
      expect(JSON.parse(String(patch!.init?.body))).toEqual({ role: "admin" });
    });
    expect(onChanged).toHaveBeenCalledWith("admin");
  });
});

describe("DeactivateButton", () => {
  test("confirming the alert dialog PATCHes /users/:id with { isActive: false }", async () => {
    const { calls } = setupFetch(({ init }) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: "u2", isActive: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });

    render(<DeactivateButton userId="u2" isActive={true} isSelf={false} />);

    fireEvent.click(screen.getByTestId("deactivate-u2"));
    const confirm = await screen.findByTestId("deactivate-confirm-u2");
    fireEvent.click(confirm);

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === "PATCH");
      expect(patch).toBeDefined();
      expect(patch!.url).toMatch(/\/users\/u2$/);
      expect(JSON.parse(String(patch!.init?.body))).toEqual({
        isActive: false,
      });
    });
  });
});
