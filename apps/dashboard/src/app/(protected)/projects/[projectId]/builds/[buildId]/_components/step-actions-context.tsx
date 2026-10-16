"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { useCommandKeys } from "@/lib/commands/registry";

/**
 * What a step card does, as its own buttons do it, for the batch page's keys
 * (`a`, `r`, Enter / `o`). The card registers these; the batch list reads
 * them for the step under its cursor. Every read is live: the values are the
 * card's as of its latest render.
 */
export interface StepActions {
  /**
   * What the card's Approve button does: decides, or, for a step a later
   * run captured again, asks the stale-step question first. `onDecided`
   * runs once the step is decided: at once, or after the question's
   * Confirm, once the question has closed (never on Cancel). Then it, not
   * the card, places focus (R26).
   */
  approve(onDecided?: () => void): void;
  /** What the card's Reject button does. */
  reject(): void;
  /** The step waits for a reviewer (new or unresolved). */
  needsReviewer: boolean;
  /**
   * Approve and Reject can be used now: the reader may review, and the run
   * takes decisions (not overridden or still processing) with none of this
   * step's on its way.
   */
  decidable: boolean;
  /** Opens the step in the viewer, with the page's review context. */
  open(): void;
}

export interface StepActionsRegistry {
  /** Registers step `id`'s actions; returns their removal. */
  register(id: string, actions: StepActions): () => void;
  /** Step `id`'s actions, while its card is mounted. */
  get(id: string): StepActions | undefined;
}

/** A registry of the step cards mounted in one batch list. */
export function createStepActions(): StepActionsRegistry {
  const byId = new Map<string, StepActions>();
  return {
    register(id, actions) {
      byId.set(id, actions);
      return () => {
        // Only its own: a card that replaced it (a remount) keeps its entry.
        if (byId.get(id) === actions) byId.delete(id);
      };
    },
    get: (id) => byId.get(id),
  };
}

const StepActionsContext = createContext<StepActionsRegistry | null>(null);

/** The hint for one of a card's decision buttons (`useCommandKeys`'s). */
export interface StepKeyHint {
  ariaKeyShortcuts?: string;
  /** " (A)", or "" when the key does nothing (none, or the switch is off). */
  titleSuffix: string;
}

/** The hints for a card's Approve and Reject: `batch.approve` / `.reject`. */
export interface StepKeys {
  approve: StepKeyHint;
  reject: StepKeyHint;
}

const NO_HINT: StepKeyHint = { titleSuffix: "" };
const NO_STEP_KEYS: StepKeys = { approve: NO_HINT, reject: NO_HINT };

const StepKeysContext = createContext<StepKeys>(NO_STEP_KEYS);

/**
 * Hands the batch list's registry to the step cards below it, with the
 * keys their Approve and Reject buttons name. The keys are read here, once
 * for the page, not once per card: a card redraws when they change (the
 * single-key switch, the role), never for another change to the registry.
 */
export function StepActionsProvider({
  value,
  children,
}: {
  value: StepActionsRegistry;
  children: ReactNode;
}) {
  const approve = useCommandKeys("batch.approve");
  const reject = useCommandKeys("batch.reject");
  const keys = useMemo<StepKeys>(
    () => ({
      approve: hint(approve.ariaKeyShortcuts, approve.titleSuffix),
      reject: hint(reject.ariaKeyShortcuts, reject.titleSuffix),
    }),
    [
      approve.ariaKeyShortcuts,
      approve.titleSuffix,
      reject.ariaKeyShortcuts,
      reject.titleSuffix,
    ],
  );
  return (
    <StepActionsContext.Provider value={value}>
      <StepKeysContext.Provider value={keys}>
        {children}
      </StepKeysContext.Provider>
    </StepActionsContext.Provider>
  );
}

function hint(
  ariaKeyShortcuts: string | undefined,
  titleSuffix: string,
): StepKeyHint {
  return ariaKeyShortcuts === undefined
    ? { titleSuffix }
    : { ariaKeyShortcuts, titleSuffix };
}

/** A card's Approve and Reject hints; none for a card outside a batch list. */
export function useStepKeys(): StepKeys {
  return useContext(StepKeysContext);
}

/** The batch list's registry, or null for a card outside one. */
export function useStepActions(): StepActionsRegistry | null {
  return useContext(StepActionsContext);
}

/**
 * Registers a card's actions under its step id while it is mounted, inside a
 * batch list (outside one it does nothing). `actions` is read afresh on every
 * call, so a key always runs the card's latest handlers and sees its latest
 * state; a re-render never re-registers.
 */
export function useRegisterStepActions(id: string, actions: StepActions): void {
  const registry = useStepActions();
  const live = useRef(actions);
  live.current = actions;
  useLayoutEffect(() => {
    if (registry === null) return;
    return registry.register(id, {
      approve: (onDecided) => live.current.approve(onDecided),
      reject: () => live.current.reject(),
      open: () => live.current.open(),
      get needsReviewer() {
        return live.current.needsReviewer;
      },
      get decidable() {
        return live.current.decidable;
      },
    });
  }, [registry, id]);
}
