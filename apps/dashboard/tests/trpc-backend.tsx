/**
 * A tRPC client for component tests whose "server" is a function. Every call
 * is recorded in `calls` and answered by `answer`, so a test sees what was
 * asked, and when, and decides when and how each question is answered. The
 * client and its cache are the real ones: react-query keys, errors and
 * stale answers behave as in the app.
 */
import type { AppRouter } from "@furan/api/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { useState, type JSX, type ReactNode } from "react";

import { trpc } from "@/lib/trpc";

/** One question the app asked its server. */
export interface Call {
  path: string;
  input: Record<string, unknown>;
}

export interface Backend {
  /** Every call so far, in the order it was made. */
  calls: Call[];
  /** Answers one call: a value, or a rejection (the call fails). */
  answer: (call: Call) => Promise<unknown>;
}

/** Every list is an empty page. */
const EMPTY_PAGE = { items: [], nextCursor: null };

/** A backend that has nothing to show and records what it is asked. */
export function createBackend(): Backend {
  return { calls: [], answer: async () => EMPTY_PAGE };
}

/** The calls to one procedure, by their input. */
export function callsTo(
  backend: Backend,
  path: string,
): Array<Record<string, unknown>> {
  return backend.calls.filter((c) => c.path === path).map((c) => c.input);
}

function backendLink(backend: Backend): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        const call: Call = {
          path: op.path,
          input: (op.input ?? {}) as Record<string, unknown>,
        };
        backend.calls.push(call);
        let listening = true;
        backend.answer(call).then(
          (data) => {
            if (!listening) return;
            observer.next({ result: { data }, context: op.context });
            observer.complete();
          },
          (cause: unknown) => {
            if (!listening) return;
            observer.error(
              TRPCClientError.from(
                cause instanceof Error ? cause : new Error(String(cause)),
              ),
            );
          },
        );
        return () => {
          listening = false;
        };
      });
}

/** The providers `Providers` mounts in the app, over a `Backend`. */
export function TrpcBackend({
  backend,
  children,
}: {
  backend: Backend;
  children: ReactNode;
}): JSX.Element {
  // The app's own defaults (`Providers`): a search that must fail fast says
  // so itself.
  const [queryClient] = useState(() => new QueryClient());
  const [client] = useState(() =>
    trpc.createClient({ links: [backendLink(backend)] }),
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
