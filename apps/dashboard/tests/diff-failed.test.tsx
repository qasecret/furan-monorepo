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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: toastSpies }));
// The stage's states are only asked what they need here, never drawn.
vi.mock("pixi.js", () => ({}));

import { CurrentProjectProvider } from "@/app/(protected)/_components/current-project-provider";
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
    // At most a quiet word that it is on its way already.
    for (const [message] of toastSpies.info.mock.calls) {
      expect(message).toBe("This step is already being re-diffed.");
    }
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
    expect(
      within(card).getByRole("button", { name: "Retry diff" }),
    ).toBeDefined();
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
      stepStates: ["unresolved"],
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
    expect(header.pendingSteps).toBe(1);
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
      stepStates: ["new"],
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
      stepStates: ["approved"],
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
    // No key: nothing is bound, so there is no cap to show.
    expect(option.querySelectorAll("kbd kbd")).toHaveLength(0);
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
