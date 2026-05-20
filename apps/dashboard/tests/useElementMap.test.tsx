import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetElementMapCacheForTests,
  useElementMap,
} from "../src/components/diff-viewer/useElementMap";

describe("useElementMap", () => {
  beforeEach(() => {
    __resetElementMapCacheForTests();
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns idle when key is null", () => {
    const { result } = renderHook(() => useElementMap(null));
    expect(result.current.state).toBe("idle");
    expect(result.current.map).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches + parses + transitions to ready", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        v: 1,
        elements: { "#x": { x: 0, y: 0, width: 10, height: 10 } },
        capturedAt: 1,
      }),
    });

    const { result } = renderHook(() =>
      useElementMap("a".repeat(64) + ".elements.json"),
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.map?.elements["#x"]).toBeDefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("transitions to error on 404", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
    });

    const { result } = renderHook(() =>
      useElementMap("b".repeat(64) + ".elements.json"),
    );
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.map).toBeNull();
  });

  it("transitions to error on malformed JSON", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("not json");
      },
    });

    const { result } = renderHook(() =>
      useElementMap("c".repeat(64) + ".elements.json"),
    );
    await waitFor(() => expect(result.current.state).toBe("error"));
  });

  it("transitions to error on v !== 1", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ v: 2, elements: {}, capturedAt: 0 }),
    });

    const { result } = renderHook(() =>
      useElementMap("d".repeat(64) + ".elements.json"),
    );
    await waitFor(() => expect(result.current.state).toBe("error"));
  });

  it("caches across renders — second render does not refetch", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ v: 1, elements: {}, capturedAt: 0 }),
    });

    const key = "e".repeat(64) + ".elements.json";
    const { result: r1 } = renderHook(() => useElementMap(key));
    await waitFor(() => expect(r1.current.state).toBe("ready"));

    const { result: r2 } = renderHook(() => useElementMap(key));
    expect(r2.current.state).toBe("ready");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
