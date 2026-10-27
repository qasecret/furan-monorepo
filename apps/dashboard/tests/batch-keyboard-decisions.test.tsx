import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The batch page's keyboard decisions with the real review hook: its
// optimistic patch, the server's answer, the rollback and its toast. Only
// the server (a scripted backend), the router and the toasts are stand-ins.
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));
vi.mock("@/hooks/use-authed-image", () => ({ useAuthedImage: () => null }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/projects/p1/builds/b1",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { createBackend, TrpcBackend, type Backend } from "./trpc-backend";

import { BatchPage } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/batch-page";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  useCommandRegistry,
} from "@/lib/commands/registry";
import { useInFlightStore } from "@/lib/review/use-review-mutations";
import { useUndoStore } from "@/lib/review/use-undo-store";
import { parseReviewContext } from "@/lib/review-context";

const BUILD = {
  id: "b1",
  ciBuildId: "ci",
  number: 42,
  name: null,
  branchName: "main",
  properties: {},
  runCount: 1,
  unresolvedCount: 1,
  failedCount: 0,
  passedCount: 0,
  abortedCount: 0,
  newCount: 0,
  stepsTotal: 2,
  pendingCheckpoints: 2,
  approvableCheckpoints: 2,
  runByName: "Jane Doe",
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const RUN = {
  id: "r1",
  name: "Checkout",
  status: "unresolved",
  statusOverride: null,
  pendingCount: 2,
  stepCount: 2,
};

const step = (id: string) => ({
  id,
  name: id,
  verdict: "unresolved",
  state: "unresolved",
  decision: null,
  newerCapture: null,
  viewport: "1280x720",
  browser: "chromium",
  os: "linux",
  device: null,
  imageKey: null,
});

/** The server's refusal: another reviewer decided c1 first. */
const refusal = () =>
  new TRPCClientError("already_decided", {
    result: {
      error: {
        code: -32009,
        message: "already_decided",
        data: {
          code: "CONFLICT",
          httpStatus: 409,
          path: "review.approve",
          details: {
            winner: { checkpointId: "c1", kind: "approved", actorName: "Ana" },
          },
        },
      },
    },
  } as never);

/** A batch of one run with two pending steps; every approve is refused. */
function refusingBackend(): Backend {
  const backend = createBackend();
  backend.answer = async ({ path }) => {
    switch (path) {
      case "builds.getById":
        return BUILD;
      case "runs.list":
        return { items: [RUN], nextCursor: null };
      case "runs.listCheckpoints":
        return { items: [step("c1"), step("c2")] };
      case "review.next":
        return {
          target: { buildId: "b1", runId: "r1", checkpointId: "c1" },
          scope: "batch",
          remaining: {
            run: 2,
            batch: 2,
            batchUnfiltered: 2,
            projectBatches: 1,
          },
          nextBatch: null,
        };
      case "runs.facets":
        return { browser: [], viewport: [], os: [], device: [] };
      case "review.approve":
        throw refusal();
      default:
        return { items: [], nextCursor: null };
    }
  };
  return backend;
}

/** A keydown on the focused element, as the browser sends it. */
function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(e);
  });
  return e;
}

const focused = () =>
  document.activeElement
    ?.closest("[data-cursor-id]")
    ?.getAttribute("data-cursor-id") ?? null;

beforeEach(() => {
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  useInFlightStore.setState({ ids: new Set(), decisions: new Set() });
  useUndoStore.setState({ stack: [] });
  for (const fn of Object.values(toastMock)) fn.mockReset();
  routerMock.push.mockReset();
});
afterEach(cleanup);

describe("BatchPage keyboard decisions, with the real review hook", () => {
  test("a refused decision leaves the cursor where it moved and shows the rollback toast", async () => {
    const backend = refusingBackend();
    render(
      <TrpcBackend backend={backend}>
        <CommandRoleProvider role="editor">
          <GlobalCommands />
          <CommandDispatcher />
          <BatchPage
            projectId="p1"
            buildId="b1"
            canReview
            context={parseReviewContext(new URLSearchParams())}
          />
        </CommandRoleProvider>
      </TrpcBackend>,
    );
    await screen.findByTestId("step-card-c2");
    press("j");
    press("j");
    expect(focused()).toBe("step:c1");

    expect(press("a").defaultPrevented).toBe(true);
    // The cursor goes on at once, with focus.
    expect(focused()).toBe("step:c2");

    // The server refuses: the step is put back, and the toast says why.
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Ana already approved c1"),
    );
    expect(
      backend.calls.filter((c) => c.path === "review.approve"),
    ).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByTestId("step-approve-c1")).toBeDefined(),
    );
    expect(useInFlightStore.getState().ids.size).toBe(0);
    // The cursor stays where it moved; nothing pulls focus back to c1.
    expect(focused()).toBe("step:c2");
    expect(
      document
        .querySelector('[data-cursor-id][tabindex="0"]')
        ?.getAttribute("data-cursor-id"),
    ).toBe("step:c2");
    // Nothing was decided, so there is nothing to undo.
    expect(useUndoStore.getState().stack).toEqual([]);
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  test("an approval that takes its run out of the filtered list leaves the focus on the item now where its card was", async () => {
    // The default "Needs review" filter: approving r1's last pending step
    // takes its row away. Nothing in the page moves focus for that (the card
    // follows it only to its own Undo or Open, which go with the row): the
    // list cursor gives it to the item at the index the cursor's item had. A
    // retry of a failed step that takes its run out of the list ends the
    // same way (`diff-failed.test.tsx`).
    const rows = [
      { ...RUN, id: "r1", name: "Checkout", pendingCount: 1, stepCount: 1 },
      { ...RUN, id: "r2", name: "Search", pendingCount: 1, stepCount: 1 },
    ];
    const backend = createBackend();
    backend.answer = async ({ path, input }) => {
      switch (path) {
        case "builds.getById":
          return BUILD;
        case "runs.list":
          return { items: rows.map((r) => ({ ...r })), nextCursor: null };
        case "runs.listCheckpoints":
          return { items: [step(input.runId === "r1" ? "c1" : "c2")] };
        case "review.next":
          return {
            target: { buildId: "b1", runId: "r2", checkpointId: "c2" },
            scope: "batch",
            remaining: {
              run: 1,
              batch: 2,
              batchUnfiltered: 2,
              projectBatches: 1,
            },
            nextBatch: null,
          };
        case "runs.facets":
          return { browser: [], viewport: [], os: [], device: [] };
        case "review.approve":
          rows.shift();
          return {
            actionId: String(input.actionId ?? "a1"),
            decided: [{ checkpointId: "c1", runId: "r1", state: "approved" }],
            runs: [{ runId: "r1", status: "passed" }],
            replayed: false,
          };
        default:
          return { items: [], nextCursor: null };
      }
    };
    render(
      <TrpcBackend backend={backend}>
        <CommandRoleProvider role="editor">
          <GlobalCommands />
          <CommandDispatcher />
          <BatchPage
            projectId="p1"
            buildId="b1"
            canReview
            context={parseReviewContext(new URLSearchParams())}
          />
        </CommandRoleProvider>
      </TrpcBackend>,
    );
    const approve = await screen.findByTestId("step-approve-c1");
    act(() => approve.focus());
    expect(focused()).toBe("step:c1");

    fireEvent.click(approve);
    await waitFor(() =>
      expect(screen.queryByTestId("result-row-r1")).toBeNull(),
    );
    await waitFor(() => expect(focused()).toBe("step:c2"));
    expect(document.activeElement).not.toBe(document.body);
  });
});
