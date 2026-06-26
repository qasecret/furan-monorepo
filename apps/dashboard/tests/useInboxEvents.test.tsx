import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInboxEvents } from "../src/hooks/useInboxEvents";

/** Minimal EventSource stand-in — mirrors the server wire shape. */
class StubEventSource {
  static instances: StubEventSource[] = [];
  url: string;
  withCredentials: boolean;
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
  fire(name: string, data: unknown): void {
    const evt = new MessageEvent(name, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(name) ?? []) fn(evt);
  }
  fireRaw(name: string, data: string): void {
    const evt = new MessageEvent(name, { data });
    for (const fn of this.listeners.get(name) ?? []) fn(evt);
  }
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useInboxEvents", () => {
  beforeEach(() => {
    StubEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
      StubEventSource as unknown as typeof EventSource;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens exactly one EventSource to /api/v1/events", () => {
    const qc = new QueryClient();
    renderHook(() => useInboxEvents("p1,p2,p3"), { wrapper: wrapper(qc) });
    expect(StubEventSource.instances).toHaveLength(1);
    expect(StubEventSource.instances[0]!.url).toContain("/api/v1/events");
    expect(StubEventSource.instances[0]!.withCredentials).toBe(true);
  });

  it("invalidates the inbox + runs + builds namespaces on a list event", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useInboxEvents(""), { wrapper: wrapper(qc) });
    const es = StubEventSource.instances[0]!;

    act(() => {
      es.fire("testRun_updated", [{ id: "x" }]);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [["inbox"]] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [["runs"]] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [["builds"]] });
  });

  it("also invalidates checkpoints on a checkpoint event", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useInboxEvents(""), { wrapper: wrapper(qc) });
    const es = StubEventSource.instances[0]!;

    act(() => {
      es.fire("run.checkpoint_diffed", [{ id: "c1" }]);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [["checkpoints"]] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [["inbox"]] });
  });

  it("invalidates the inbox once on (re)connect via the open event", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useInboxEvents(""), { wrapper: wrapper(qc) });
    const es = StubEventSource.instances[0]!;

    act(() => {
      es.fire("open", null);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [["inbox"]] });
  });

  it("silently drops a malformed frame (non-JSON or valid-JSON non-array)", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useInboxEvents(""), { wrapper: wrapper(qc) });
    const es = StubEventSource.instances[0]!;

    expect(() => {
      act(() => {
        es.fireRaw("testRun_updated", "not-json"); // JSON.parse throws
        es.fireRaw("testRun_updated", "{}"); // valid JSON, not an array
      });
    }).not.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reconnects (closes old, opens new) when the reconnect key changes", () => {
    const qc = new QueryClient();
    const { rerender } = renderHook(({ k }) => useInboxEvents(k), {
      wrapper: wrapper(qc),
      initialProps: { k: "p1" },
    });
    expect(StubEventSource.instances).toHaveLength(1);

    rerender({ k: "p1,p2" });
    expect(StubEventSource.instances).toHaveLength(2);
    expect(StubEventSource.instances[0]!.closed).toBe(true);
    expect(StubEventSource.instances[1]!.closed).toBe(false);
  });

  it("closes the EventSource on unmount", () => {
    const qc = new QueryClient();
    const { unmount } = renderHook(() => useInboxEvents(""), {
      wrapper: wrapper(qc),
    });
    const es = StubEventSource.instances[0]!;
    unmount();
    expect(es.closed).toBe(true);
  });
});
