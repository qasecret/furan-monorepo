"use client";

import {
  isPending,
  reviewRefusalReasonSchema,
  type ApproveBuildPreview,
  type CheckpointDecisionKind,
  type ReviewErrorDetails,
} from "@furan/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { create } from "zustand";

import {
  decisionChange,
  patchListedRun,
  pendingDelta,
  revertChange,
  runStatusFor,
  withPendingDelta,
  type Actor,
  type ReviewChange,
  type RunsListPage,
} from "./optimistic";
import { describeRefusal, describeSkip } from "./review-copy";
import { useUndoStore } from "./use-undo-store";

import { trpc, type RouterInputs, type RouterOutputs } from "@/lib/trpc";

type DecideResult = RouterOutputs["review"]["approve"];
type RevertResult = RouterOutputs["review"]["revert"];

export interface DecideArgs {
  runId: string;
  /** Omit to decide every pending step of the run. */
  checkpointIds?: string[];
  kind: CheckpointDecisionKind;
  /** The success toast, e.g. "Approved home". It is also the undo entry's name. */
  label: string;
  /** Only with exactly one checkpoint id, and only for an approval. */
  ignoreAreas?: RouterInputs["review"]["approve"]["ignoreAreas"];
  /** Only for a rejection. */
  reason?: string;
}

export interface DecideGroupArgs {
  runId: string;
  /** The checkpoint the group was built around. */
  checkpointId: string;
  kind: CheckpointDecisionKind;
  label: string;
}

export interface ApproveBuildArgs {
  buildId: string;
  /** The pending count the reviewer confirmed. */
  expectedCount: number;
  label: string;
  /** The batch changed since `expectedCount` was read; here is the new preview. */
  onConflict(preview: ApproveBuildPreview): void;
}

/** What the server tells the client when a review call is refused. */
interface ReviewError {
  message: string;
  data?: { code?: string; details?: ReviewErrorDetails } | null;
}

const GENERIC_ERROR = "Couldn't save your review. Try again.";
const UNDO_TOAST_MS = 10_000;

/** Shown for a decision until the refetch brings the real reviewer back. */
const OPTIMISTIC_ACTOR: Actor = { id: "", name: "You" };

interface InFlightState {
  ids: ReadonlySet<string>;
  hold(ids: readonly string[]): void;
  release(ids: readonly string[]): void;
}

/**
 * Checkpoints with a decision on its way to the server. Shared by every
 * consumer of the hook, so the viewer and the batch page agree, and held in a
 * store so the buttons that read `isInFlight` re-render when it changes.
 */
export const useInFlightStore = create<InFlightState>((set) => ({
  ids: new Set(),
  hold: (ids) => set((s) => ({ ids: new Set([...s.ids, ...ids]) })),
  release: (ids) =>
    set((s) => {
      const next = new Set(s.ids);
      for (const id of ids) next.delete(id);
      return { ids: next };
    }),
}));

/**
 * What a call needs from the moment it is made until it settles. The tRPC
 * input carries only the action id, so the rest waits here under that id; it is
 * read by the mutation callbacks, which keep running after the component that
 * made the call has unmounted.
 */
interface Action {
  label: string;
  /** Runs to patch before the answer, and (when known) the undo entry's runs. */
  runIds: string[];
  /** The optimistic change; none for group and build actions (the server picks the members). */
  change?: ReviewChange;
  /** Checkpoints held in flight until the call settles. */
  held: string[];
  onConflict?: (preview: ApproveBuildPreview) => void;
  /** Undoes each cache patch, in the order they were made. */
  restores: Array<() => void>;
}

const ACTIONS = new Map<string, Action>();

/** Puts every cache back the way it was, newest patch first. */
function rollBack(action: Action): void {
  for (const restore of action.restores.splice(0).reverse()) restore();
}

/**
 * A v4 UUID. `crypto.randomUUID` only exists in secure contexts, and a
 * self-hosted dashboard is often opened over plain http on a LAN address.
 */
function newActionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The toast for a failed call, from the error the server gave. */
function errorText(
  err: ReviewError,
  stepName: (checkpointId: string) => string | undefined,
): string {
  const code = err.data?.code;
  const details = err.data?.details;
  if (code === "CONFLICT" && err.message === "already_decided") {
    const winner = details?.winner;
    if (!winner) return describeRefusal("already_decided");
    return `${winner.actorName ?? "Someone"} already ${winner.kind} ${stepName(winner.checkpointId) ?? "this step"}`;
  }
  if (code === "PRECONDITION_FAILED") {
    const reason = reviewRefusalReasonSchema.safeParse(err.message);
    if (reason.success) return describeRefusal(reason.data);
  }
  if (code === "FORBIDDEN" && err.message === "not_decider") {
    return describeSkip("not_decider");
  }
  return GENERIC_ERROR;
}

/**
 * Every review decision and undo in the dashboard goes through here: the
 * per-step and per-run decisions, the group and build approvals and the undo
 * of any of them.
 *
 * A step or run decision (and an undo of one) shows its result at once, in the
 * caches that are loaded, and puts them back if the server refuses. Group and
 * build approvals wait for the server: it picks their members, and the build
 * one runs behind a confirmation that has its own pending state. Every call,
 * however it ends, refetches the review caches.
 */
export function useReviewMutations() {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const inFlight = useInFlightStore((s) => s.ids);

  /**
   * Shows `change` on the review caches that are loaded: the run's
   * checkpoints and detail, the run's row on every `runs.list` page, and the
   * pending count of its build. A cache that is not loaded is left alone.
   */
  const patchRun = async (
    runId: string,
    change: ReviewChange,
    restores: Action["restores"],
  ) => {
    // An answer already on its way would land on top of the patch.
    await Promise.all([
      utils.runs.listCheckpoints.cancel({ runId }),
      utils.runs.getById.cancel({ runId }),
      utils.runs.list.cancel(),
      utils.builds.getById.cancel(),
    ]);

    const put = <T>(
      before: T | undefined,
      after: T | undefined,
      write: (value: T) => void,
    ) => {
      if (before === undefined || after === undefined) return;
      write(after);
      restores.push(() => write(before));
    };

    const list = utils.runs.listCheckpoints.getData({ runId });
    const nextList = list && { ...list, items: change.items(list.items) };
    put(list, nextList, (v) =>
      utils.runs.listCheckpoints.setData({ runId }, v),
    );

    // The run's status is derived from the patched checkpoint list when that
    // is loaded, otherwise from the patched contexts of the run itself.
    const run = utils.runs.getById.getData({ runId });
    const nextRun = run && change.run(run, nextList?.items);
    put(run, nextRun, (v) => utils.runs.getById.setData({ runId }, v));

    // `runs.list` is cached once per filter and cursor: patch every page.
    let buildId = run?.buildId;
    const pages = queryClient.getQueriesData<RunsListPage>({
      queryKey: getQueryKey(trpc.runs.list),
    });
    for (const [key, page] of pages) {
      if (!page?.items) continue;
      buildId ??= page.items.find((r) => r.id === runId)?.buildId;
      if (!nextRun && !nextList) continue;
      const next = patchListedRun(
        page,
        runId,
        (row) =>
          nextRun?.status ??
          (nextList
            ? runStatusFor(nextList.items, row.status, row.statusOverride)
            : row.status),
      );
      put(page, next === page ? undefined : next, (v) =>
        queryClient.setQueryData(key, v),
      );
    }

    // The steps that stopped (or started) needing a reviewer move the build's count.
    const before =
      list?.items ?? (run && Object.values(run.checkpointContexts));
    const after =
      nextList?.items ?? (nextRun && Object.values(nextRun.checkpointContexts));
    if (buildId && before && after) {
      const build = utils.builds.getById.getData({ buildId });
      put(
        build,
        build && withPendingDelta(build, pendingDelta(before, after)),
        (v) => utils.builds.getById.setData({ buildId }, v),
      );
    }
  };

  const onMutate = async ({ actionId }: { actionId: string }) => {
    const action = ACTIONS.get(actionId);
    if (!action?.change) return;
    try {
      for (const runId of action.runIds) {
        await patchRun(runId, action.change, action.restores);
      }
    } catch {
      // The patch is only a courtesy: whatever went wrong with it, the call
      // still goes out, and the refetch that follows shows the truth.
      rollBack(action);
    }
  };

  const onError = (err: ReviewError, { actionId }: { actionId: string }) => {
    const action = ACTIONS.get(actionId);
    if (!action) return;
    rollBack(action);
    const preview = err.data?.details?.preview;
    if (
      err.data?.code === "CONFLICT" &&
      err.message === "batch_changed" &&
      preview &&
      action.onConflict
    ) {
      action.onConflict(preview);
      return;
    }
    toast.error(
      errorText(
        err,
        (checkpointId) =>
          action.runIds
            .flatMap(
              (runId) =>
                utils.runs.listCheckpoints.getData({ runId })?.items ?? [],
            )
            .find((item) => item.id === checkpointId)?.name,
      ),
    );
  };

  const onSettled = (
    _data: unknown,
    _err: unknown,
    { actionId }: { actionId: string },
  ) => {
    const action = ACTIONS.get(actionId);
    ACTIONS.delete(actionId);
    if (action) useInFlightStore.getState().release(action.held);
    void utils.runs.listCheckpoints.invalidate();
    void utils.runs.getById.invalidate();
    void utils.runs.list.invalidate();
    void utils.builds.getById.invalidate();
  };

  const settle = { onMutate, onError, onSettled };

  const revert = trpc.review.revert.useMutation({
    ...settle,
    onError: (err: ReviewError, vars: { actionId: string }) => {
      // An undo that can never succeed is forgotten. Any other failure keeps
      // its place on the stack, so the next ⌘Z retries the same action.
      const code = err.data?.code;
      if (
        code === "NOT_FOUND" ||
        (code === "FORBIDDEN" && err.message === "not_decider")
      ) {
        useUndoStore.getState().drop(vars.actionId);
      }
      onError(err, vars);
    },
    onSuccess: ({ reverted, skipped }: RevertResult, { actionId }) => {
      useUndoStore.getState().drop(actionId);
      if (skipped.length === 0) {
        toast.success("Undone");
      } else if (
        reverted === 0 &&
        skipped.every((s) => s.reason === "already_undone")
      ) {
        toast.info("Already undone");
      } else {
        const reasons = new Set(skipped.map((s) => describeSkip(s.reason)));
        toast.warning(
          `Undid ${reverted} of ${reverted + skipped.length}: ${[...reasons].join("; ")}`,
        );
      }
    },
  });

  /**
   * Takes back an action: the one named, or the newest this session made. The
   * entry stays on the stack until the undo succeeds (or can never succeed),
   * so a failed undo can be retried and the stack keeps its order.
   */
  const undo = useCallback(
    (actionId?: string) => {
      const { stack } = useUndoStore.getState();
      const entry =
        actionId === undefined
          ? stack.at(-1)
          : stack.find((e) => e.actionId === actionId);
      const id = actionId ?? entry?.actionId;
      // Nothing to undo, or this action is still in flight (a second click):
      // leave the stack exactly as it is.
      if (id === undefined || ACTIONS.has(id)) return;
      ACTIONS.set(id, {
        label: entry?.label ?? "",
        // An action that is not in this session's stack (a decision from
        // before a reload) has no known runs: it is refetched, not patched.
        runIds: entry?.runIds ?? [],
        change: revertChange(id),
        held: [],
        restores: [],
      });
      revert.mutate({ actionId: id });
    },
    [revert.mutate],
  );

  const decided = (
    { runs }: DecideResult,
    { actionId }: { actionId: string },
  ) => {
    const action = ACTIONS.get(actionId);
    if (!action) return;
    // Group and build actions learn which runs they touched from the answer.
    const runIds =
      action.runIds.length > 0 ? action.runIds : runs.map((r) => r.runId);
    useUndoStore.getState().push({ actionId, label: action.label, runIds });
    toast.success(action.label, {
      action: { label: "Undo", onClick: () => undo(actionId) },
      duration: UNDO_TOAST_MS,
    });
  };

  const decideOptions = { ...settle, onSuccess: decided };
  const approve = trpc.review.approve.useMutation(decideOptions);
  const reject = trpc.review.reject.useMutation(decideOptions);
  const approveGroup = trpc.review.approveGroup.useMutation(decideOptions);
  const rejectGroup = trpc.review.rejectGroup.useMutation(decideOptions);
  const approveBuildMutation =
    trpc.review.approveBuild.useMutation(decideOptions);

  const decide = useCallback(
    (args: DecideArgs) => {
      const { runId, checkpointIds, kind, label } = args;
      const steps = utils.runs.listCheckpoints.getData({ runId })?.items ?? [];
      // No ids means every pending step, as it does on the server. Without
      // the list there is nothing to patch, and the call still goes out.
      const targets =
        checkpointIds ??
        steps
          .filter((i) => i.state !== null && isPending(i.state))
          .map((i) => i.id);
      // A run-wide decision can reach any step of the run, and its own patch
      // has already made the steps it targets look decided: so a second click
      // is caught by any step of the run being in flight, not by the targets.
      const reach = checkpointIds ?? steps.map((i) => i.id);
      const flying = useInFlightStore.getState().ids;
      if (reach.some((id) => flying.has(id))) return;

      const actionId = newActionId();
      useInFlightStore.getState().hold(targets);
      ACTIONS.set(actionId, {
        label,
        runIds: [runId],
        change: decisionChange(
          new Set(targets),
          kind,
          OPTIMISTIC_ACTOR,
          actionId,
        ),
        held: targets,
        restores: [],
      });
      const input = {
        runId,
        actionId,
        ...(checkpointIds && { checkpointIds }),
      };
      if (kind === "approved") {
        approve.mutate({
          ...input,
          ...(args.ignoreAreas && { ignoreAreas: args.ignoreAreas }),
        });
      } else {
        reject.mutate({
          ...input,
          ...(args.reason !== undefined && { reason: args.reason }),
        });
      }
    },
    [utils, approve.mutate, reject.mutate],
  );

  const decideGroup = useCallback(
    ({ runId, checkpointId, kind, label }: DecideGroupArgs) => {
      if (useInFlightStore.getState().ids.has(checkpointId)) return;
      const actionId = newActionId();
      useInFlightStore.getState().hold([checkpointId]);
      ACTIONS.set(actionId, {
        label,
        runIds: [],
        held: [checkpointId],
        restores: [],
      });
      (kind === "approved" ? approveGroup : rejectGroup).mutate({
        runId,
        checkpointId,
        actionId,
      });
    },
    [approveGroup.mutate, rejectGroup.mutate],
  );

  const approveBuild = useCallback(
    ({ buildId, expectedCount, label, onConflict }: ApproveBuildArgs) => {
      const actionId = newActionId();
      ACTIONS.set(actionId, {
        label,
        runIds: [],
        held: [],
        onConflict,
        restores: [],
      });
      approveBuildMutation.mutate({ buildId, actionId, expectedCount });
    },
    [approveBuildMutation.mutate],
  );

  const isInFlight = useCallback(
    (checkpointId: string) => inFlight.has(checkpointId),
    [inFlight],
  );

  return { decide, approveBuild, decideGroup, undo, isInFlight };
}
