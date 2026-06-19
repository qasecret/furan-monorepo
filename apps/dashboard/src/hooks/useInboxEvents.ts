"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { browserEnv } from "@/lib/env";

/**
 * The 9 event names emitted on the project SSE channels. Must stay in lockstep
 * with `ProjectEventName` in apps/api/src/lib/broadcast.ts and the per-project
 * client hook `useProjectEvents`.
 */
const INBOX_EVENT_NAMES = [
  "build_created",
  "build_updated",
  "build_deleted",
  "testRun_created",
  "testRun_updated",
  "testRun_deleted",
  "run.checkpoint_added",
  "run.checkpoint_diffed",
  "run.completed",
] as const;
type InboxEventName = (typeof INBOX_EVENT_NAMES)[number];

const CHECKPOINT_EVENT_NAMES = new Set<InboxEventName>([
  "run.checkpoint_added",
  "run.checkpoint_diffed",
  "run.completed",
]);

/**
 * Single multiplexed SSE connection for the cross-project inbox.
 *
 * Opens ONE EventSource to `/api/v1/events`, which streams events for every
 * project the caller can access — regardless of project count. This is what
 * keeps the inbox under the browser's ~6-per-origin HTTP/1.1 connection cap
 * (the old one-EventSource-per-project fan-out saturated it and starved other
 * XHRs).
 *
 * `reconnectKey` is a client-side reconnect trigger only: when the caller's
 * set of projects changes (InboxRealtime passes a sorted-joined id string),
 * the effect re-runs and reopens the connection so the server re-enumerates
 * membership and picks up newly-added projects. The server does NOT read the
 * key — it enumerates from auth.
 *
 * Side effect only: invalidates the inbox (queue + count badge) plus the
 * runs/builds list namespaces; checkpoint events also invalidate checkpoints.
 * On (re)connect a one-shot inbox invalidate catches anything missed during a
 * drop.
 *
 * Spec: furan-design/specs/2026-06-19-multiplexed-inbox-sse-design.md
 */
export function useInboxEvents(reconnectKey = ""): void {
  const qc = useQueryClient();

  useEffect(() => {
    const url = `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/events`;
    const es = new EventSource(url, { withCredentials: true });

    const invalidateInbox = (): void => {
      void qc.invalidateQueries({ queryKey: [["inbox"]] });
      void qc.invalidateQueries({ queryKey: [["runs"]] });
      void qc.invalidateQueries({ queryKey: [["builds"]] });
    };

    // One-shot refetch on (re)connect catches events missed during a drop.
    es.addEventListener("open", invalidateInbox);

    const handlers = new Map<InboxEventName, (m: MessageEvent) => void>();
    for (const name of INBOX_EVENT_NAMES) {
      const isCheckpoint = CHECKPOINT_EVENT_NAMES.has(name);
      const handler = (m: MessageEvent): void => {
        try {
          const items: unknown = JSON.parse(m.data);
          if (!Array.isArray(items)) return;
        } catch {
          return;
        }
        invalidateInbox();
        if (isCheckpoint) {
          void qc.invalidateQueries({ queryKey: [["checkpoints"]] });
        }
      };
      handlers.set(name, handler);
      es.addEventListener(name, handler as EventListener);
    }

    return () => {
      es.removeEventListener("open", invalidateInbox);
      for (const [name, handler] of handlers) {
        es.removeEventListener(name, handler as EventListener);
      }
      es.close();
    };
  }, [qc, reconnectKey]);
}
