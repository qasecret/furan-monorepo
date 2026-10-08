/**
 * A collector for side effects that must run AFTER a request's scoped
 * transaction commits (ADR-058) — chiefly diff-job enqueues that reference
 * just-written rows, so a worker can't observe the job before the rows are
 * visible. One shared primitive backs both request surfaces: the tRPC
 * `scopeToUser` middleware and the REST `withRequestScope` wrapper.
 *
 * `onCommit` registers an effect; `drain` runs them in registration order.
 * The caller decides WHEN to drain (only on success — a rolled-back or errored
 * unit of work must not fire its effects).
 */
export interface DeferredSink {
  onCommit: (effect: () => unknown) => void;
  drain: () => Promise<void>;
}

export function createDeferredSink(): DeferredSink {
  const effects: Array<() => unknown> = [];
  return {
    onCommit: (effect) => {
      effects.push(effect);
    },
    drain: async () => {
      for (const effect of effects) await effect();
    },
  };
}
