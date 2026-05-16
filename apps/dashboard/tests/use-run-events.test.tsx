import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRunEvents } from "../src/hooks/useRunEvents";

interface MockMessageEvent {
  data: string;
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  listeners: Record<string, ((m: MockMessageEvent) => void)[]> = {};
  closed = false;
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (m: MockMessageEvent) => void): void {
    this.listeners[type] = this.listeners[type] ?? [];
    this.listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: (m: MockMessageEvent) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  emit(type: string, data: unknown): void {
    const payload =
      typeof data === "string" ? data : JSON.stringify(data ?? null);
    (this.listeners[type] ?? []).forEach((fn) => fn({ data: payload }));
  }
  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  (
    globalThis as unknown as { EventSource: typeof MockEventSource }
  ).EventSource = MockEventSource;
});

afterEach(() => {
  delete (globalThis as unknown as { EventSource?: typeof MockEventSource })
    .EventSource;
  vi.clearAllMocks();
});

describe("useRunEvents", () => {
  it("opens an EventSource for the given runId and forwards parsed progress events", () => {
    const onEvent = vi.fn();
    renderHook(() => useRunEvents("run-1", onEvent));
    const es = MockEventSource.instances[0]!;
    expect(es.url).toContain("/api/v1/runs/run-1/events");
    expect(es.withCredentials).toBe(true);
    act(() => es.emit("progress", { type: "diff.completed", runId: "run-1" }));
    expect(onEvent).toHaveBeenCalledWith({
      type: "diff.completed",
      runId: "run-1",
    });
  });

  it("does not open an EventSource when runId is null", () => {
    renderHook(() => useRunEvents(null, () => undefined));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHook(() =>
      useRunEvents("run-1", () => undefined),
    );
    const es = MockEventSource.instances[0]!;
    unmount();
    expect(es.closed).toBe(true);
  });

  it("forwards updated callbacks without reopening the EventSource", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: (e: unknown) => void }) => useRunEvents("run-1", cb),
      { initialProps: { cb: first } },
    );
    expect(MockEventSource.instances).toHaveLength(1);
    rerender({ cb: second });
    // Re-render with a new callback must NOT spin up a second EventSource.
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0]!;
    act(() => es.emit("progress", { type: "run.completed", runId: "run-1" }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({
      type: "run.completed",
      runId: "run-1",
    });
  });

  it("ignores malformed JSON payloads silently", () => {
    const onEvent = vi.fn();
    renderHook(() => useRunEvents("run-1", onEvent));
    const es = MockEventSource.instances[0]!;
    act(() => es.emit("progress", "not-json{"));
    expect(onEvent).not.toHaveBeenCalled();
  });
});
