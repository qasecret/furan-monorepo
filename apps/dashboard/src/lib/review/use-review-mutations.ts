"use client";

import {
  isPending,
  reviewRefusalReasonSchema,
  type ApproveBuildPreview,
  type CheckpointDecisionKind,
  type ReviewErrorDetails,
} from "@furan/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { create } from "zustand";

import {
  cancelRun,
  loadedDecisions,
  patchRun,
  runsDecidedBy,
  type Caches,
} from "./cache-patch";
import {
  decisionChange,
  restoreChange,
  revertChange,
  type Actor,
  type ReviewChange,
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
  /**
   * Builds the change that takes `change` back, once the caches are quiet and
   * before they are patched. It is applied to whatever the caches hold when
   * the call fails, so it undoes only this action's own patch.
   */
  inverse?: (caches: Caches) => ReviewChange;
  /** Set once the caches are patched; what a failure applies. */
  rollback?: ReviewChange;
  /** Checkpoints held in flight until the call settles. */
  held: string[];
  onConflict?: (preview: ApproveBuildPreview) => void;
}

const ACTIONS = new Map<string, Action>();

/**
 * Registers the action and holds its checkpoints before `send` makes the call;
 * should anything throw, neither is left behind.
 */
function start(actionId: string, action: Action, send: () => void): void {
  ACTIONS.set(actionId, action);
  try {
    useInFlightStore.getState().hold(action.held);
    send();
  } catch (error) {
    ACTIONS.delete(actionId);
    useInFlightStore.getState().release(action.held);
    throw error;
  }
}

/** Takes the action's own patch back off the caches, as they are now. */
function rollBack(caches: Caches, action: Action): void {
  const { rollback } = action;
  action.rollback = undefined;
  if (!rollback) return;
  for (const runId of action.runIds) {
    try {
      patchRun(caches, runId, rollback);
    } catch {
      // Best effort: the refetch that follows every call corrects the rest.
    }
  }
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
  const caches: Caches = useMemo(
    () => ({ utils, queryClient }),
    [utils, queryClient],
  );

  const onMutate = async ({ actionId }: { actionId: string }) => {
    const action = ACTIONS.get(actionId);
    if (!action?.change) return;
    try {
      await Promise.all(action.runIds.map((runId) => cancelRun(caches, runId)));
      action.rollback = action.inverse?.(caches);
      for (const runId of action.runIds) {
        patchRun(caches, runId, action.change);
      }
    } catch {
      // The patch is only a courtesy: whatever went wrong with it, the call
      // still goes out, and the refetch that follows shows the truth.
      rollBack(caches, action);
    }
  };

  const onError = (err: ReviewError, { actionId }: { actionId: string }) => {
    const action = ACTIONS.get(actionId);
    if (!action) return;
    rollBack(caches, action);
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
      // The runs the action decided in: this session's entry knows them; for a
      // decision from before a reload they are found in the loaded caches.
      const runIds = entry?.runIds ?? runsDecidedBy(caches, id);
      start(
        id,
        {
          label: entry?.label ?? "",
          runIds,
          change: revertChange(id),
          // The decisions this undo clears, to put back if it fails.
          inverse: (c) => restoreChange(loadedDecisions(c, runIds, id)),
          // A decide on one of these steps waits for the undo to finish.
          held: [...loadedDecisions(caches, runIds, id).keys()],
        },
        () => revert.mutate({ actionId: id }),
      );
    },
    [revert.mutate, caches],
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
      const input = {
        runId,
        actionId,
        ...(checkpointIds && { checkpointIds }),
      };
      start(
        actionId,
        {
          label,
          runIds: [runId],
          change: decisionChange(
            new Set(targets),
            kind,
            OPTIMISTIC_ACTOR,
            actionId,
          ),
          // Only this action's own decisions are taken back on a failure.
          inverse: () => revertChange(actionId),
          held: targets,
        },
        () => {
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
      );
    },
    [utils, approve.mutate, reject.mutate],
  );

  const decideGroup = useCallback(
    ({ runId, checkpointId, kind, label }: DecideGroupArgs) => {
      if (useInFlightStore.getState().ids.has(checkpointId)) return;
      const actionId = newActionId();
      start(actionId, { label, runIds: [], held: [checkpointId] }, () =>
        (kind === "approved" ? approveGroup : rejectGroup).mutate({
          runId,
          checkpointId,
          actionId,
        }),
      );
    },
    [approveGroup.mutate, rejectGroup.mutate],
  );

  const approveBuild = useCallback(
    ({ buildId, expectedCount, label, onConflict }: ApproveBuildArgs) => {
      const actionId = newActionId();
      start(actionId, { label, runIds: [], held: [], onConflict }, () =>
        approveBuildMutation.mutate({ buildId, actionId, expectedCount }),
      );
    },
    [approveBuildMutation.mutate],
  );

  const isInFlight = useCallback(
    (checkpointId: string) => inFlight.has(checkpointId),
    [inFlight],
  );

  return { decide, approveBuild, decideGroup, undo, isInFlight };
}
