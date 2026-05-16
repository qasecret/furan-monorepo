"use client";

import { useEffect, useRef } from "react";

import { browserEnv } from "@/lib/env";

/**
 * Discriminated union of progress events published by the API SSE channel
 * `GET /api/v1/runs/:id/events` (see apps/api/src/routes/run-events.ts).
 *
 * The final `string` arm is a forward-compatibility catch-all so the consumer
 * does not need to be redeployed in lockstep with new worker event types.
 */
export type RunEvent =
  | {
      type: "capture.started";
      runId: string;
      viewport?: unknown;
      browser?: string;
    }
  | {
      type: "capture.completed";
      runId: string;
      imageKey?: string;
      durationMs?: number;
    }
  | { type: "diff.started"; runId: string }
  | {
      type: "diff.completed";
      runId: string;
      passed?: boolean;
      diffPercent?: number;
      ranTiers?: string[];
      firstBaseline?: boolean;
      durationMs?: number;
    }
  | { type: "run.completed"; runId: string }
  | { type: string; [key: string]: unknown };

/**
 * Subscribes to the run's SSE channel and forwards parsed `progress` frames
 * to `onEvent`.
 *
 * Implementation note — `handlerRef` indirection: callers will typically pass
 * a fresh closure each render (capturing component state like `queryClient`).
 * Depending the effect on `onEvent` directly would tear down and reopen the
 * EventSource on every render, which is wasteful and would drop in-flight
 * frames. Reading through a ref keeps the connection stable while still
 * dispatching to the latest handler.
 */
export function useRunEvents(
  runId: string | null,
  onEvent: (e: RunEvent) => void,
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!runId) return;
    const url = `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/runs/${runId}/events`;
    const es = new EventSource(url, { withCredentials: true });

    const onProgress = (m: Event) => {
      const msg = m as MessageEvent;
      try {
        const data = JSON.parse(msg.data) as RunEvent;
        handlerRef.current(data);
      } catch {
        // Malformed payload — silently drop. Logging here would be noisy
        // across reconnects and the server-side framing is well-typed.
      }
    };
    es.addEventListener("progress", onProgress);

    return () => {
      es.removeEventListener("progress", onProgress);
      es.close();
    };
  }, [runId]);
}
