"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

/**
 * What a step card does, as its own buttons do it, for the batch page's keys
 * (`a`, `r`, Enter / `o`). The card registers these; the batch list reads
 * them for the step under its cursor. Every read is live: the values are the
 * card's as of its latest render.
 */
export interface StepActions {
  /**
   * What the card's Approve button does: decides, or, for a step a later
   * run captured again, asks the stale-step question first (`asksFirst`).
   */
  approve(): void;
  /** What the card's Reject button does. */
  reject(): void;
  /** The step waits for a reviewer (new or unresolved). */
  needsReviewer: boolean;
  /**
   * Approve and Reject can be used now: the reader may review, and the run
   * takes decisions (not overridden or still processing) with none of this
   * step's on its way.
   */
  canReview: boolean;
  /**
   * Approve only asks (an older capture): nothing is decided until the
   * question is answered.
   */
  asksFirst: boolean;
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

/** Hands the batch list's registry to the step cards below it. */
export function StepActionsProvider({
  value,
  children,
}: {
  value: StepActionsRegistry;
  children: ReactNode;
}) {
  return (
    <StepActionsContext.Provider value={value}>
      {children}
    </StepActionsContext.Provider>
  );
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
      approve: () => live.current.approve(),
      reject: () => live.current.reject(),
      open: () => live.current.open(),
      get needsReviewer() {
        return live.current.needsReviewer;
      },
      get canReview() {
        return live.current.canReview;
      },
      get asksFirst() {
        return live.current.asksFirst;
      },
    });
  }, [registry, id]);
}
