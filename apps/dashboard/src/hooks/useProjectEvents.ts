"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { browserEnv } from "@/lib/env";

/**
 * The six legacy event names emitted on the project SSE channel
 * `GET /api/v1/projects/:id/events`. Server-side these get batched by
 * the per-event debouncer in `apps/api/src/routes/project-events.ts`
 * (1.5s wait / 3s max-wait) and flushed as `event: <name>\ndata:
 * <items[]>\n\n` frames.
 *
 * Spec: furan-design/specs/2026-05-24-list-level-live-updates-design.md
 */
const PROJECT_EVENT_NAMES = [
  "build_created",
  "build_updated",
  "build_deleted",
  "testRun_created",
  "testRun_updated",
  "testRun_deleted",
] as const;
type ProjectEventName = (typeof PROJECT_EVENT_NAMES)[number];

type EventHandler = () => void;

interface PoolEntry {
  es: EventSource;
  refCount: number;
  /** Hook-instance handlers, fanned out on each frame. */
  subscribers: Set<EventHandler>;
  /** Cached DOM listeners so we can remove the right reference on close. */
  domHandlers: Record<ProjectEventName, (m: MessageEvent) => void>;
}

/**
 * One EventSource per projectId. Each page (Builds index, Runs index,
 * Build detail, Variation detail) calls `useProjectEvents(projectId)`;
 * if two of them mount simultaneously we keep a single TCP connection,
 * ref-counted, and tear down only when the last consumer unmounts.
 *
 * Module-level state is safe here — the dashboard is client-only and
 * the React-Query cache is per-app. The pool resets across
 * `__resetProjectEventsPoolForTests()` calls.
 */
const pool = new Map<string, PoolEntry>();

function open(projectId: string): PoolEntry {
  const existing = pool.get(projectId);
  if (existing) return existing;

  const url = `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/projects/${projectId}/events`;
  const es = new EventSource(url, { withCredentials: true });

  const subscribers = new Set<EventHandler>();
  const fanOut = (): void => {
    for (const fn of subscribers) fn();
  };

  // One DOM listener per event name. All 6 funnel through fanOut so
  // subscribers don't have to differentiate by event type — every
  // event invalidates the same two query namespaces anyway. Parsing
  // the frame is best-effort; malformed data drops silently.
  const domHandlers = {} as Record<ProjectEventName, (m: MessageEvent) => void>;
  for (const name of PROJECT_EVENT_NAMES) {
    const handler = (m: MessageEvent): void => {
      try {
        const items: unknown = JSON.parse(m.data);
        if (!Array.isArray(items)) return;
      } catch {
        return;
      }
      fanOut();
    };
    domHandlers[name] = handler;
    es.addEventListener(name, handler as EventListener);
  }

  const entry: PoolEntry = { es, refCount: 0, subscribers, domHandlers };
  pool.set(projectId, entry);
  return entry;
}

function close(projectId: string): void {
  const entry = pool.get(projectId);
  if (!entry || entry.refCount > 0) return;
  for (const name of PROJECT_EVENT_NAMES) {
    entry.es.removeEventListener(
      name,
      entry.domHandlers[name] as EventListener,
    );
  }
  entry.es.close();
  pool.delete(projectId);
}

/**
 * Internal: cache invalidation fan-out shared by every event name.
 * Every project-channel event affects either the runs list, the builds
 * list, or both (a status flip on a run also changes the build's
 * aggregate counters). We invalidate both namespaces unconditionally —
 * the cost is bounded by the server's 1.5s debounce so callers can't
 * thrash this.
 */
function invalidateLists(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: [["runs"]] });
  void qc.invalidateQueries({ queryKey: [["builds"]] });
}

/**
 * Subscribes the calling page to the project's SSE channel. Mount it
 * once per page; multiple mounts on the same projectId share one
 * EventSource via the pool.
 *
 * The hook returns nothing — the side effect is React-Query cache
 * invalidation. Pages re-render naturally when their `list` queries
 * refetch.
 */
export function useProjectEvents(projectId: string | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!projectId) return;
    const entry = open(projectId);
    const handler: EventHandler = () => invalidateLists(qc);
    entry.subscribers.add(handler);
    entry.refCount += 1;

    return () => {
      entry.subscribers.delete(handler);
      entry.refCount -= 1;
      if (entry.refCount === 0) close(projectId);
    };
  }, [projectId, qc]);
}

/** Test-only seam: drops every pooled EventSource. */
export function __resetProjectEventsPoolForTests(): void {
  for (const projectId of Array.from(pool.keys())) {
    const entry = pool.get(projectId);
    if (!entry) continue;
    entry.refCount = 0;
    close(projectId);
  }
}
