import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetProjectEventsPoolForTests,
  useProjectEvents,
} from "../src/hooks/useProjectEvents";

/**
 * Minimal EventSource stand-in. The real DOM EventSource is not
 * available in jsdom, and we don't want the test to make a real
 * network request, so we record listeners + provide a `.fire(name,
 * data)` test seam that mirrors the wire shape the server emits:
 * `event: <name>\ndata: <JSON array>\n\n`.
 */
class StubEventSource {
  static instances: StubEventSource[] = [];
  url: string;
  withCredentials: boolean;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    StubEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn);
  }

  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  // Test seam: simulate a server-side flush of the named event.
  fire(name: string, data: unknown): void {
    const evt = new MessageEvent(name, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(name) ?? []) fn(evt);
  }
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useProjectEvents", () => {
  beforeEach(() => {
    StubEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
      StubEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    __resetProjectEventsPoolForTests();
    vi.restoreAllMocks();
  });

  it("opens one EventSource per projectId and tears it down on unmount", () => {
    const qc = new QueryClient();
    const { unmount } = renderHook(() => useProjectEvents("proj-1"), {
      wrapper: wrapper(qc),
    });

    expect(StubEventSource.instances).toHaveLength(1);
    expect(StubEventSource.instances[0]!.url).toContain(
      "/api/v1/projects/proj-1/events",
    );
    expect(StubEventSource.instances[0]!.withCredentials).toBe(true);

    unmount();
    expect(StubEventSource.instances[0]!.closed).toBe(true);
  });

  it("no-ops when projectId is null", () => {
    const qc = new QueryClient();
    renderHook(() => useProjectEvents(null), { wrapper: wrapper(qc) });
    expect(StubEventSource.instances).toHaveLength(0);
  });

  it("ref-counts the EventSource across two simultaneous mounts on the same projectId", () => {
    const qc = new QueryClient();
    const a = renderHook(() => useProjectEvents("proj-1"), {
      wrapper: wrapper(qc),
    });
    const b = renderHook(() => useProjectEvents("proj-1"), {
      wrapper: wrapper(qc),
    });

    // Only one EventSource was opened — the pool keyed by projectId.
    expect(StubEventSource.instances).toHaveLength(1);

    // First unmount: connection stays open (still one subscriber).
    a.unmount();
    expect(StubEventSource.instances[0]!.closed).toBe(false);

    // Second unmount: refCount hits zero, EventSource closes.
    b.unmount();
    expect(StubEventSource.instances[0]!.closed).toBe(true);
  });

  it("invalidates runs + builds query namespaces on every event name", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    renderHook(() => useProjectEvents("proj-1"), { wrapper: wrapper(qc) });
    const es = StubEventSource.instances[0]!;

    const eventNames = [
      "build_created",
      "build_updated",
      "build_deleted",
      "testRun_created",
      "testRun_updated",
      "testRun_deleted",
    ] as const;

    for (const name of eventNames) {
      invalidate.mockClear();
      act(() => {
        es.fire(name, [{ id: "x" }]);
      });
      // Two invalidate calls per event: one for [["runs"]], one for [["builds"]].
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [["runs"]] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [["builds"]] });
    }
  });

  it("silently drops a malformed frame (non-JSON data) without throwing", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useProjectEvents("proj-1"), { wrapper: wrapper(qc) });
    const es = StubEventSource.instances[0]!;

    // Simulate a frame with non-JSON data — the hook should not throw
    // and should not invalidate.
    expect(() => {
      const bad = new MessageEvent("testRun_updated", { data: "not-json" });
      (
        es as unknown as {
          listeners: Map<string, Set<(e: MessageEvent) => void>>;
        }
      ).listeners
        .get("testRun_updated")
        ?.forEach((fn) => fn(bad));
    }).not.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("opens separate connections for distinct projectIds", () => {
    const qc = new QueryClient();
    renderHook(() => useProjectEvents("proj-A"), { wrapper: wrapper(qc) });
    renderHook(() => useProjectEvents("proj-B"), { wrapper: wrapper(qc) });

    expect(StubEventSource.instances).toHaveLength(2);
    expect(StubEventSource.instances[0]!.url).toContain("/proj-A/events");
    expect(StubEventSource.instances[1]!.url).toContain("/proj-B/events");
  });
});
