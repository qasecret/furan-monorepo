/**
 * A step whose diff failed for good (spec 2026-10-23 §10): the batch page's
 * card and run row, the viewer's stage state and its disabled decisions, and
 * the palette's Retry diff. The server side is `runs.retryDiff`; here it is a
 * function (`TrpcBackend`), so a test sees what was asked and decides when
 * the list changes.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  callsTo,
  createBackend,
  TrpcBackend,
  type Backend,
} from "./trpc-backend";

const { reviewSpies, toastSpies } = vi.hoisted(() => ({
  reviewSpies: { decide: vi.fn(), undo: vi.fn() },
  toastSpies: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => reviewSpies,
  useIsInFlight: () => false,
}));
vi.mock("@/hooks/use-authed-image", () => ({ useAuthedImage: () => null }));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/p1/builds/b1",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("sonner", () => ({ toast: toastSpies }));
// The stage's states are only asked what they need here, never drawn.
vi.mock("pixi.js", () => ({}));

import { CurrentProjectProvider } from "@/app/(protected)/_components/current-project-provider";
import { BatchPage } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/batch-page";
import { RunResults } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/run-results";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { deriveReviewHeader } from "@/components/diff-viewer/review-header-state";
import {
  stageStates,
  StageStates,
  type StageState,
  type StageStatesInput,
} from "@/components/diff-viewer/StageStates";
import {
  useDiffViewerShortcuts,
  type ShortcutOptions,
} from "@/components/diff-viewer/useDiffViewerShortcuts";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import {
  CommandRoleProvider,
  useCommandRegistry,
} from "@/lib/commands/registry";
import { diffErrorCode, diffErrorCopy } from "@/lib/diff-error-copy";
import { describeRefusal } from "@/lib/review/review-copy";
import { parseReviewContext } from "@/lib/review-context";
import type { ViewerRole } from "@/lib/roles";
import { trpc } from "@/lib/trpc";
import { useRetryDiff } from "@/lib/use-retry-diff";

const CLEAN = parseReviewContext(new URLSearchParams());
const FAILED_AT = "2026-10-24T08:00:00.000Z";

/** A step of `runs.listCheckpoints`, as the server answers it. */
function step(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "home",
    viewport: "1280x720",
    browser: "chromium",
    os: "linux",
    device: null,
    matchLevel: "strict",
    imageKey: "k1",
    testVariationId: null,
    createdAt: "2026-10-24T07:00:00.000Z",
    verdict: "unresolved",
    state: "unresolved",
    decision: null,
    newerCapture: null,
    diffFailedAt: null,
    diffError: null,
    diffPercent: 1.5,
    vlmDescription: null,
    diffGeneration: 1,
    ...over,
  };
}

/** A step whose diff failed for good. */
const failed = (over: Record<string, unknown> = {}) =>
  step({
    diffFailedAt: FAILED_AT,
    diffError: "engine_error",
    diffPercent: null,
    ...over,
  });

/** Settles a refusal as the server sends one. */
const refusal = (message: string, code: string, status: number) =>
  new TRPCClientError(message, {
    result: {
      error: {
        code: -32009,
        message,
        data: { code, httpStatus: status, path: "runs.retryDiff" },
      },
    },
  } as never);

/**
 * A server holding one run's steps. `retryDiff` clears the failure of the step
 * it names, as the real call does; `retried` says what it was asked.
 */
function runServer(items: Array<Record<string, unknown>>): {
  backend: Backend;
  items: Array<Record<string, unknown>>;
} {
  const backend = createBackend();
  backend.answer = async ({ path, input }) => {
    switch (path) {
      case "runs.listCheckpoints":
        return { items: items.map((i) => ({ ...i })) };
      case "runs.retryDiff": {
        const at = items.findIndex((i) => i.id === input.checkpointId);
        if (at < 0 || items[at]!.diffFailedAt === null) {
          throw refusal("step_not_failed", "PRECONDITION_FAILED", 412);
        }
        items[at] = {
          ...items[at]!,
          verdict: null,
          state: null,
          diffFailedAt: null,
          diffError: null,
        };
        return { status: "running" };
      }
      default:
        return { items: [], nextCursor: null };
    }
  };
  return { backend, items };
}

function renderRun(
  backend: Backend,
  over: { canReview?: boolean; fallbackStatus?: string } = {},
) {
  return render(
    <TrpcBackend backend={backend}>
      <RunResults
        projectId="p1"
        runId="r1"
        testName="Login"
        branchName="main"
        fallbackStatus={(over.fallbackStatus ?? "unresolved") as never}
        statusOverride={null}
        ctx={CLEAN}
        view="list"
        canReview={over.canReview ?? true}
      />
    </TrpcBackend>,
  );
}

beforeEach(() => {
  reviewSpies.decide.mockReset();
  reviewSpies.undo.mockReset();
  for (const spy of Object.values(toastSpies)) spy.mockReset();
});
afterEach(cleanup);

const REASONS = {
  image_unreadable: "The screenshot couldn't be read.",
  object_missing: "An image is missing from storage.",
  engine_error: "The comparison failed.",
  vlm_error: "The visual AI step failed.",
  timeout: "The diff didn't finish in time.",
  internal: "Something went wrong. Retry, or check the worker logs.",
} as const;

describe("diffErrorCopy", () => {
  test("maps all six codes to the spec's copy and falls back to internal", () => {
    for (const [code, copy] of Object.entries(REASONS)) {
      expect(diffErrorCopy(code)).toBe(copy);
    }
    expect(diffErrorCopy("a_code_from_a_newer_worker")).toBe(REASONS.internal);
    expect(diffErrorCopy("")).toBe(REASONS.internal);
  });

  test("diffErrorCode keeps a known code and reads anything else as internal", () => {
    expect(diffErrorCode("timeout")).toBe("timeout");
    expect(diffErrorCode("nope")).toBe("internal");
    expect(diffErrorCode(null)).toBe("internal");
    expect(diffErrorCode(undefined)).toBe("internal");
  });
});

describe("the batch step card", () => {
  test("a failed step card shows Diff failed, the reason, and Retry for an editor", async () => {
    const { backend } = runServer([failed()]);
    renderRun(backend);
    const card = await screen.findByTestId("step-card-c1");

    // The card is named by its state, and the strip says why.
    expect(card.getAttribute("aria-label")).toBe("home, Diff failed");
    const strip = within(card).getByTestId("step-diff-failed-c1");
    expect(within(strip).getByText("Diff failed")).toBeDefined();
    expect(within(strip).getByText(REASONS.engine_error)).toBeDefined();
    expect(
      within(card).getByRole("button", { name: "Retry diff for home" }),
    ).toBeDefined();
  });

  test("a code the dashboard doesn't know reads as the internal reason", async () => {
    const { backend } = runServer([failed({ diffError: "from_the_future" })]);
    renderRun(backend);
    const strip = await screen.findByTestId("step-diff-failed-c1");
    expect(within(strip).getByText(REASONS.internal)).toBeDefined();
  });

  test("a guest sees the state without Retry", async () => {
    const { backend } = runServer([failed({ diffError: "timeout" })]);
    renderRun(backend, { canReview: false });
    const card = await screen.findByTestId("step-card-c1");
    expect(card.getAttribute("aria-label")).toBe("home, Diff failed");
    expect(within(card).getByText(REASONS.timeout)).toBeDefined();
    expect(
      within(card).queryByRole("button", { name: /Retry diff/ }),
    ).toBeNull();
  });

  test("a step that did not fail shows no failure", async () => {
    const { backend } = runServer([step()]);
    renderRun(backend);
    const card = await screen.findByTestId("step-card-c1");
    expect(card.getAttribute("aria-label")).toBe("home, Unresolved");
    expect(within(card).queryByTestId("step-diff-failed-c1")).toBeNull();
    expect(screen.queryByTestId("result-diff-failed-r1")).toBeNull();
  });

  test("Approve and Reject are held back with Retry the diff first", async () => {
    const { backend } = runServer([failed()]);
    renderRun(backend);
    const approve = await screen.findByTestId("step-approve-c1");
    const reject = screen.getByTestId("step-reject-c1");
    for (const button of [approve, reject]) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("aria-describedby")).not.toBeNull();
    }
    expect(approve.getAttribute("aria-label")).toBe("Approve home");
    // The reason a screen reader is given is the spec's tooltip.
    const reasonId = approve.getAttribute("aria-describedby")!;
    expect(document.getElementById(reasonId)?.textContent).toBe(
      "Retry the diff first",
    );
    fireEvent.click(approve);
    fireEvent.click(reject);
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("Retry calls runs.retryDiff and shows the in-progress look until the result lands", async () => {
    const server = runServer([failed(), step({ id: "c2", name: "cart" })]);
    let utils!: ReturnType<typeof trpc.useUtils>;
    function Probe() {
      utils = trpc.useUtils();
      return null;
    }
    render(
      <TrpcBackend backend={server.backend}>
        <Probe />
        <RunResults
          projectId="p1"
          runId="r1"
          testName="Login"
          branchName="main"
          fallbackStatus="unresolved"
          statusOverride={null}
          ctx={CLEAN}
          view="list"
          canReview
        />
      </TrpcBackend>,
    );
    const card = await screen.findByTestId("step-card-c1");
    expect(card.getAttribute("aria-label")).toBe("home, Diff failed");

    fireEvent.click(
      within(card).getByRole("button", { name: "Retry diff for home" }),
    );

    // The call names the run and the step.
    await waitFor(() =>
      expect(callsTo(server.backend, "runs.retryDiff")).toEqual([
        { runId: "r1", checkpointId: "c1" },
      ]),
    );
    // The list is read again, and the step reads as being diffed: the look of
    // any step without a verdict yet, with nothing left to retry.
    await waitFor(() =>
      expect(
        screen.getByTestId("step-card-c1").getAttribute("aria-label"),
      ).toBe("home, Running"),
    );
    expect(screen.queryByTestId("step-diff-failed-c1")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry diff/ })).toBeNull();
    // The other step is untouched.
    expect(screen.getByTestId("step-card-c2").getAttribute("aria-label")).toBe(
      "cart, Unresolved",
    );

    // The worker settles the step; the next read shows its result.
    server.items[0] = step({ id: "c1", diffPercent: 3 });
    await act(async () => {
      await utils.runs.listCheckpoints.invalidate({ runId: "r1" });
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("step-card-c1").getAttribute("aria-label"),
      ).toBe("home, Unresolved"),
    );
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  test("the card keeps the focus when the retry takes its button away", async () => {
    const server = runServer([failed()]);
    renderRun(server.backend);
    const button = await screen.findByRole("button", {
      name: "Retry diff for home",
    });
    act(() => button.focus());
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Retry diff/ })).toBeNull(),
    );
    // Not dropped to the page: on the card's own Open control.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open home in the viewer" }),
    );
  });

  test("a retry another reviewer made first is already handled: no error, the list is read again", async () => {
    const server = runServer([failed()]);
    renderRun(server.backend);
    const card = await screen.findByTestId("step-card-c1");
    // Someone else retried it meanwhile: the server has no failure to clear.
    server.items[0] = step({ verdict: null, state: null });
    fireEvent.click(
      within(card).getByRole("button", { name: "Retry diff for home" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("step-card-c1").getAttribute("aria-label"),
      ).toBe("home, Running"),
    );
    expect(toastSpies.error).not.toHaveBeenCalled();
    // The one quiet word: it is on its way already.
    expect(toastSpies.info).toHaveBeenCalledOnce();
    expect(toastSpies.info).toHaveBeenCalledWith(
      "This step is already being re-diffed.",
    );
    // The list was read twice: once on mount, once after the refusal.
    expect(callsTo(server.backend, "runs.listCheckpoints")).toHaveLength(2);
  });

  test("any other error is said in a toast, and the card stays retryable", async () => {
    const server = runServer([failed()]);
    const answer = server.backend.answer;
    server.backend.answer = async (call) => {
      if (call.path === "runs.retryDiff") {
        throw refusal("FORBIDDEN", "FORBIDDEN", 403);
      }
      return answer(call);
    };
    renderRun(server.backend);
    const card = await screen.findByTestId("step-card-c1");
    fireEvent.click(
      within(card).getByRole("button", { name: "Retry diff for home" }),
    );
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledOnce());
    expect(toastSpies.error.mock.calls[0]![0]).toMatch(/permission/i);
    // Still failed, and Retry takes another press once the call has settled.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Retry diff for home" })
          .getAttribute("aria-busy"),
      ).toBeNull(),
    );
    expect(screen.getByTestId("step-card-c1").getAttribute("aria-label")).toBe(
      "home, Diff failed",
    );
  });

  test("Retry is busy and inert while the call is out", async () => {
    const server = runServer([failed()]);
    let release!: () => void;
    const answer = server.backend.answer;
    server.backend.answer = async (call) => {
      if (call.path === "runs.retryDiff") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return answer(call);
    };
    renderRun(server.backend);
    const button = await screen.findByRole("button", {
      name: "Retry diff for home",
    });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // A second press asks nothing more.
    fireEvent.click(button);
    expect(callsTo(server.backend, "runs.retryDiff")).toHaveLength(1);
    await act(async () => release());
  });
});

describe("the run row", () => {
  test("shows Diff failed (2) for two failed steps, and keeps the run's status", async () => {
    const { backend } = runServer([
      failed({ id: "c1", name: "a" }),
      failed({ id: "c2", name: "b", diffError: "timeout" }),
      step({ id: "c3", name: "c" }),
    ]);
    renderRun(backend);
    const badge = await screen.findByTestId("result-diff-failed-r1");
    expect(badge.textContent).toBe("Diff failed (2)");
    // The status pill is the run's rollup, as before.
    const row = screen.getByTestId("result-row-r1");
    expect(within(row).getByText("Unresolved")).toBeDefined();
  });

  test("counts one failed step and none when no step failed", async () => {
    const one = runServer([failed(), step({ id: "c2", name: "cart" })]);
    renderRun(one.backend);
    expect(
      (await screen.findByTestId("result-diff-failed-r1")).textContent,
    ).toBe("Diff failed (1)");
    cleanup();

    const none = runServer([step(), step({ id: "c2", name: "cart" })]);
    renderRun(none.backend);
    await screen.findByTestId("step-card-c1");
    expect(screen.queryByTestId("result-diff-failed-r1")).toBeNull();
  });
});

/**
 * The batch page under its default "Needs review" filter. Retrying r1's
 * failed step makes the run `running`, so the filtered list no longer holds
 * it, as approving a run's last pending step takes it away (the same
 * scenario with an approval is in `batch-keyboard-decisions.test.tsx`). Focus
 * must not fall to the page: the list cursor gives it to the item that is now
 * where the retried step's card was, `step:c2`.
 */
describe("a retry that takes its run out of the filtered list", () => {
  const BUILD = {
    id: "b1",
    ciBuildId: "ci",
    number: 42,
    name: null,
    branchName: "main",
    properties: {},
    runCount: 2,
    unresolvedCount: 2,
    failedCount: 0,
    passedCount: 0,
    abortedCount: 0,
    newCount: 0,
    stepsTotal: 2,
    pendingCheckpoints: 2,
    // r1's failed step is pending, not approvable.
    approvableCheckpoints: 1,
    runByName: "Jane Doe",
    aggregateStatus: "unresolved",
    createdAt: FAILED_AT,
    updatedAt: FAILED_AT,
  };
  const row = (id: string, name: string) => ({
    id,
    name,
    status: "unresolved",
    statusOverride: null,
    pendingCount: 1,
    stepCount: 1,
  });
  const NEXT = {
    target: { buildId: "b1", runId: "r2", checkpointId: "c2" },
    scope: "batch",
    remaining: { run: 1, batch: 2, batchUnfiltered: 2, projectBatches: 1 },
    nextBatch: null,
  };

  /**
   * Two runs in the list, r1 with a failed step c1 and r2 with a pending c2.
   * `gate` holds the named reads until released, to choose which lands first
   * after the change: the run list (the whole row goes while the focus is on
   * the Retry button) or the run's steps (the button goes, the card stays).
   */
  function pendingBatch(hold: string[] = []) {
    const rows = [row("r1", "Checkout"), row("r2", "Search")];
    let c1 = failed({ id: "c1", name: "c1" });
    const c2 = step({ id: "c2", name: "c2" });
    const gates = new Map<string, () => void>();
    const waits = new Map<string, Promise<void>>();
    for (const key of hold) {
      waits.set(key, new Promise<void>((resolve) => gates.set(key, resolve)));
    }
    const backend = createBackend();
    backend.answer = async ({ path, input }) => {
      // A read that was asked after the change waits for its gate.
      const wait =
        waits.get(`${path}:${String(input.runId ?? "")}`) ?? waits.get(path);
      if (wait && rows.length === 1) await wait;
      switch (path) {
        case "builds.getById":
          return BUILD;
        case "runs.list":
          return { items: rows.map((r) => ({ ...r })), nextCursor: null };
        case "runs.listCheckpoints":
          return { items: [input.runId === "r1" ? c1 : c2] };
        case "review.next":
          return NEXT;
        case "runs.facets":
          return { browser: [], viewport: [], os: [], device: [] };
        case "runs.retryDiff":
          c1 = step({ id: "c1", name: "c1", verdict: null, state: null });
          rows.shift();
          return { status: "running" };
        default:
          return { items: [], nextCursor: null };
      }
    };
    return { backend, release: (key: string) => gates.get(key)?.() };
  }

  /** The list item that has the focus, or holds the control that has it. */
  const focused = () =>
    document.activeElement
      ?.closest("[data-cursor-id]")
      ?.getAttribute("data-cursor-id") ?? null;

  function renderBatch(backend: Backend) {
    return render(
      <TrpcBackend backend={backend}>
        <CommandRoleProvider role="editor">
          <BatchPage projectId="p1" buildId="b1" canReview context={CLEAN} />
        </CommandRoleProvider>
      </TrpcBackend>,
    );
  }

  beforeEach(() => {
    useCommandRegistry.setState({ entries: [], role: "guest" });
  });

  test.each([
    [
      "the run list lands first: the whole row goes with the focus on Retry",
      "runs.listCheckpoints:r1",
    ],
    ["the run's steps land first: Retry goes, then the row", "runs.list"],
  ])("a retry: %s", async (_name, held) => {
    const { backend, release } = pendingBatch([held]);
    renderBatch(backend);
    const retry = await screen.findByRole("button", {
      name: "Retry diff for c1",
    });
    act(() => retry.focus());
    expect(focused()).toBe("step:c1");

    fireEvent.click(retry);
    await waitFor(() =>
      expect(callsTo(backend, "runs.retryDiff")).toHaveLength(1),
    );
    // Whichever read lands first, then the other.
    await waitFor(() =>
      expect(
        held === "runs.list"
          ? screen.queryByRole("button", { name: /Retry diff/ })
          : screen.queryByTestId("result-row-r1"),
      ).toBeNull(),
    );
    release(held);

    await waitFor(() =>
      expect(screen.queryByTestId("result-row-r1")).toBeNull(),
    );
    // Not the page: the item now where the retried step's card was.
    await waitFor(() => expect(focused()).toBe("step:c2"));
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("useRetryDiff", () => {
  test("reads the run's steps, the run and the run lists again after a retry", async () => {
    const server = runServer([failed()]);
    let hook!: ReturnType<typeof useRetryDiff>;
    function Probe() {
      hook = useRetryDiff("r1");
      // The three views a retry changes, each with an observer to refetch.
      trpc.runs.listCheckpoints.useQuery({ runId: "r1" });
      trpc.runs.getById.useQuery({ runId: "r1" });
      trpc.runs.list.useQuery({ projectId: "p1" } as never);
      return null;
    }
    render(
      <TrpcBackend backend={server.backend}>
        <Probe />
      </TrpcBackend>,
    );
    await waitFor(() => expect(server.backend.calls).toHaveLength(3));
    expect(hook.pending).toBe(false);
    server.backend.calls.length = 0;

    await act(async () => {
      await hook.retry("c1");
    });

    const paths = server.backend.calls.map((c) => c.path).sort();
    expect(paths).toEqual([
      "runs.getById",
      "runs.list",
      "runs.listCheckpoints",
      "runs.retryDiff",
    ]);
    expect(hook.pending).toBe(false);
  });

  test("is pending while a retry is out, and a second retry asks nothing more", async () => {
    const server = runServer([failed()]);
    let release!: () => void;
    const answer = server.backend.answer;
    server.backend.answer = async (call) => {
      if (call.path === "runs.retryDiff") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return answer(call);
    };
    let hook!: ReturnType<typeof useRetryDiff>;
    function Probe() {
      hook = useRetryDiff("r1");
      return null;
    }
    render(
      <TrpcBackend backend={server.backend}>
        <Probe />
      </TrpcBackend>,
    );

    let first!: Promise<void>;
    act(() => {
      first = hook.retry("c1");
      void hook.retry("c1");
    });
    await waitFor(() => expect(hook.pending).toBe(true));
    expect(callsTo(server.backend, "runs.retryDiff")).toHaveLength(1);

    await act(async () => {
      release();
      await first;
    });
    expect(hook.pending).toBe(false);
  });
});

describe("useRetryDiff per step", () => {
  test("pending is keyed by step: another step's retry is not held up by one that is out", async () => {
    const server = runServer([
      failed({ id: "c1", name: "a" }),
      failed({ id: "c2", name: "b" }),
    ]);
    const releases = new Map<string, () => void>();
    const answer = server.backend.answer;
    server.backend.answer = async (call) => {
      if (call.path === "runs.retryDiff") {
        await new Promise<void>((resolve) => {
          releases.set(String(call.input.checkpointId), resolve);
        });
      }
      return answer(call);
    };
    let hook!: ReturnType<typeof useRetryDiff>;
    function Probe() {
      hook = useRetryDiff("r1");
      return null;
    }
    render(
      <TrpcBackend backend={server.backend}>
        <Probe />
      </TrpcBackend>,
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.retry("c1");
    });
    await waitFor(() => expect(hook.isPending("c1")).toBe(true));
    expect(hook.isPending("c2")).toBe(false);
    expect(hook.pending).toBe(true);

    // The other step asks at once, with the first still out.
    act(() => {
      second = hook.retry("c2");
    });
    await waitFor(() =>
      expect(callsTo(server.backend, "runs.retryDiff")).toEqual([
        { runId: "r1", checkpointId: "c1" },
        { runId: "r1", checkpointId: "c2" },
      ]),
    );
    expect(hook.isPending("c2")).toBe(true);

    // The first settles; the second is still out.
    await act(async () => {
      releases.get("c1")!();
      await first;
    });
    expect(hook.isPending("c1")).toBe(false);
    expect(hook.isPending("c2")).toBe(true);
    expect(hook.pending).toBe(true);

    await act(async () => {
      releases.get("c2")!();
      await second;
    });
    expect(hook.pending).toBe(false);
  });
});

describe("the viewer's stage", () => {
  const sized = (w: number, h: number) => ({
    key: `k${w}x${h}`,
    bitmap: { width: w, height: h } as ImageBitmap,
    size: { w, h },
  });

  /** Diff mode with both screenshots in and no diff image: R4's "no changes". */
  function input(over: Partial<StageStatesInput> = {}): StageStatesInput {
    const baseline = sized(100, 200);
    const current = sized(100, 200);
    return {
      mode: "diff",
      set: {
        status: "ready",
        images: { baseline, current },
        failed: {},
        retry: () => {},
      },
      hasBaseline: true,
      legacyMissing: false,
      stepHasDiff: false,
      sizes: { baseline: baseline.size, current: current.size },
      maxTextureSize: 16384,
      ...over,
    };
  }

  test("a failed diff is a state with its code, and the 'no changes' message is not said over it", () => {
    expect(stageStates(input()).map((s) => s.kind)).toEqual([
      "diff-no-changes",
    ]);

    const states = stageStates(input({ diffFailed: "timeout" }));
    expect(states).toEqual([{ kind: "diff-failed", code: "timeout" }]);
  });

  test("a failed diff on a step without a baseline does not say Approve makes one", () => {
    const states = stageStates(
      input({
        mode: "side-by-side",
        hasBaseline: false,
        diffFailed: "internal",
      }),
    );
    expect(states.map((s) => s.kind)).toEqual(["diff-failed"]);
  });

  test("the viewer shows the diff-failed stage state with the reason", () => {
    const states: StageState[] = [{ kind: "diff-failed", code: "vlm_error" }];
    render(
      <StageStates states={states} onRetry={vi.fn()} onRetryDiff={vi.fn()} />,
    );
    const card = screen.getByTestId("stage-diff-failed");
    expect(card.textContent).toContain(
      `This step's diff failed. ${REASONS.vlm_error}`,
    );
    // The stage's live region announces it.
    expect(screen.getByTestId("stage-states").getAttribute("role")).toBe(
      "status",
    );
    // The button is named as the copy says; the message describes it.
    const retry = within(card).getByRole("button", { name: "Retry diff" });
    const described = document.getElementById(
      retry.getAttribute("aria-describedby") ?? "",
    );
    expect(described?.textContent).toBe(
      `This step's diff failed. ${REASONS.vlm_error}`,
    );
  });

  test("Retry diff asks for the retry once; while it is out the button is busy and inert", () => {
    const onRetryDiff = vi.fn();
    const states: StageState[] = [{ kind: "diff-failed", code: "internal" }];
    const view = render(
      <StageStates
        states={states}
        onRetry={vi.fn()}
        onRetryDiff={onRetryDiff}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry diff" }));
    expect(onRetryDiff).toHaveBeenCalledOnce();

    view.rerender(
      <StageStates
        states={states}
        onRetry={vi.fn()}
        onRetryDiff={onRetryDiff}
        retryingDiff
      />,
    );
    const busy = screen.getByRole("button", { name: "Retry diff" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(onRetryDiff).toHaveBeenCalledOnce();
  });

  test("when its Retry diff goes with the focus on it, the focus is handed on", () => {
    const onFocusLost = vi.fn();
    const states: StageState[] = [{ kind: "diff-failed", code: "timeout" }];
    const view = render(
      <StageStates
        states={states}
        onRetry={vi.fn()}
        onRetryDiff={vi.fn()}
        onFocusLost={onFocusLost}
      />,
    );
    // Gone without the focus on it: nothing to hand on.
    view.rerender(
      <StageStates states={[]} onRetry={vi.fn()} onFocusLost={onFocusLost} />,
    );
    expect(onFocusLost).not.toHaveBeenCalled();

    view.rerender(
      <StageStates
        states={states}
        onRetry={vi.fn()}
        onRetryDiff={vi.fn()}
        onFocusLost={onFocusLost}
      />,
    );
    act(() => screen.getByRole("button", { name: "Retry diff" }).focus());
    view.rerender(
      <StageStates states={[]} onRetry={vi.fn()} onFocusLost={onFocusLost} />,
    );
    expect(onFocusLost).toHaveBeenCalledOnce();
  });

  test("without a way to retry (a guest) the state shows and has no button", () => {
    render(
      <StageStates
        states={[{ kind: "diff-failed", code: "object_missing" }]}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId("stage-diff-failed").textContent).toContain(
      `This step's diff failed. ${REASONS.object_missing}`,
    );
    expect(screen.queryByRole("button", { name: "Retry diff" })).toBeNull();
  });
});

describe("approve and reject on a failed step", () => {
  const base = (over: Partial<Parameters<typeof deriveReviewHeader>[0]> = {}) =>
    deriveReviewHeader({
      status: "unresolved",
      statusOverride: null,
      step: { state: "unresolved", hasDecision: false, diffFailed: true },
      runSteps: [{ state: "unresolved", diffFailed: true }],
      stepInFlight: false,
      runInFlight: false,
      ...over,
    });

  test("are disabled with the spec's reason, and the step stays pending for the loop", () => {
    const header = base();
    expect(header.canApprove).toBe(false);
    expect(header.canReject).toBe(false);
    expect(header.disabledReason).toBe("Retry the diff first");
    expect(header.disabledReason).toBe(describeRefusal("diff_failed"));
    // Pending: the review loop stops on it, and `j` moves on from it.
    expect(header.view).toBe("pending");
    // Approve pending steps skips it, so it is not in that count.
    expect(header.pendingSteps).toBe(0);
  });

  test("a step whose diff did not fail is unchanged", () => {
    const header = base({
      step: { state: "unresolved", hasDecision: false, diffFailed: false },
    });
    expect(header.canApprove).toBe(true);
    expect(header.canReject).toBe(true);
    expect(header.disabledReason).toBeNull();
  });

  test("a new step whose diff failed is held back too", () => {
    const header = base({
      step: { state: "new", hasDecision: false, diffFailed: true },
      runSteps: [{ state: "new", diffFailed: true }],
    });
    expect(header.canApprove).toBe(false);
    expect(header.canReject).toBe(false);
  });

  test("a run that cannot take decisions keeps its own reason", () => {
    expect(base({ statusOverride: "failed" }).disabledReason).toBe(
      describeRefusal("run_overridden"),
    );
  });

  test("a decided step keeps its decision", () => {
    const header = base({
      step: { state: "approved", hasDecision: true, diffFailed: true },
      runSteps: [{ state: "approved", diffFailed: true }],
    });
    expect(header.view).toBe("decided");
  });
});

describe("the palette", () => {
  /** The diff viewer's page commands, registered as the viewer does. */
  function Viewer(opts: ShortcutOptions) {
    useDiffViewerShortcuts(opts);
    return null;
  }

  function Shell({
    role = "editor",
    children,
  }: {
    role?: ViewerRole;
    children?: ReactNode;
  }) {
    return (
      <TrpcBackend backend={createBackend()}>
        <CommandRoleProvider role={role}>
          <CurrentProjectProvider
            initialProjects={[{ id: "p1", name: "Acme" }]}
            initialDefaultProjectId="p1"
          >
            <GlobalCommands />
            <CommandDispatcher />
            {children}
            <CommandPalette userRole={role} userId="user-a" />
          </CurrentProjectProvider>
        </CommandRoleProvider>
      </TrpcBackend>
    );
  }

  async function actions(): Promise<string[]> {
    act(() => usePaletteStore.getState().setOpen(true));
    const palette = await screen.findByTestId("command-palette");
    const group = within(palette).queryByRole("group", { name: "Actions" });
    return group
      ? within(group)
          .queryAllByRole("option")
          .map((o) => o.firstElementChild?.textContent ?? "")
      : [];
  }

  beforeEach(() => {
    usePaletteStore.setState({ open: false });
    useCommandRegistry.setState({ entries: [], role: "guest" });
    localStorage.clear();
  });
  afterEach(() => usePaletteStore.setState({ open: false }));

  test("lists Retry diff only on a failed step, and runs the retry", async () => {
    const onRetryDiff = vi.fn();
    const view = render(
      <Shell>
        <Viewer viewports={[]} onNextDiff={vi.fn()} />
      </Shell>,
    );
    expect(await actions()).not.toContain("Retry diff");
    view.unmount();
    act(() => usePaletteStore.setState({ open: false }));
    useCommandRegistry.setState({ entries: [], role: "guest" });

    render(
      <Shell>
        <Viewer viewports={[]} onNextDiff={vi.fn()} onRetryDiff={onRetryDiff} />
      </Shell>,
    );
    expect(await actions()).toContain("Retry diff");

    const palette = screen.getByTestId("command-palette");
    const option = within(palette).getByRole("option", { name: /Retry diff/ });
    fireEvent.click(option);
    await waitFor(() => expect(onRetryDiff).toHaveBeenCalledOnce());
  });

  test("is not offered to a guest", async () => {
    render(
      <Shell role="guest">
        <Viewer viewports={[]} onNextDiff={vi.fn()} onRetryDiff={vi.fn()} />
      </Shell>,
    );
    expect(await actions()).not.toContain("Retry diff");
  });
});
