import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  clearClipboardRegion,
  getClipboardRegion,
  setClipboardRegion,
  useClipboardRegion,
} from "../src/components/diff-viewer/region-clipboard";

const sampleRegion = {
  id: "client-uuid-1",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  viewport: "1280x720",
  paddingPx: 4,
  kind: "dynamic-text" as const,
  pattern: "\\d{4}-\\d{2}-\\d{2}",
};

const PROJECT_A = "00000000-0000-0000-0000-000000000aaa";
const PROJECT_B = "00000000-0000-0000-0000-000000000bbb";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe("region-clipboard module", () => {
  test("set then get round-trips region minus id", () => {
    setClipboardRegion(PROJECT_A, sampleRegion);
    const got = getClipboardRegion(PROJECT_A);
    expect(got).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      viewport: "1280x720",
      paddingPx: 4,
      kind: "dynamic-text",
      pattern: "\\d{4}-\\d{2}-\\d{2}",
    });
  });

  test("get for an unknown project returns null", () => {
    setClipboardRegion(PROJECT_A, sampleRegion);
    expect(getClipboardRegion(PROJECT_B)).toBeNull();
  });

  test("get with no entry returns null", () => {
    expect(getClipboardRegion(PROJECT_A)).toBeNull();
  });

  test("version mismatch returns null (forward-compat)", () => {
    sessionStorage.setItem(
      `furan:region-clipboard:${PROJECT_A}`,
      JSON.stringify({ _v: 99, region: { x: 0 }, copiedAt: 0 }),
    );
    expect(getClipboardRegion(PROJECT_A)).toBeNull();
  });

  test("malformed JSON returns null", () => {
    sessionStorage.setItem(`furan:region-clipboard:${PROJECT_A}`, "not-json");
    expect(getClipboardRegion(PROJECT_A)).toBeNull();
  });

  test("clear removes the entry", () => {
    setClipboardRegion(PROJECT_A, sampleRegion);
    clearClipboardRegion(PROJECT_A);
    expect(getClipboardRegion(PROJECT_A)).toBeNull();
  });

  test("set fires a same-tab custom event", () => {
    let fired: { projectId: string } | null = null;
    const listener = (e: Event) => {
      fired = (e as CustomEvent<{ projectId: string }>).detail;
    };
    window.addEventListener("furan:clipboard-changed", listener);
    setClipboardRegion(PROJECT_A, sampleRegion);
    window.removeEventListener("furan:clipboard-changed", listener);
    expect(fired).toEqual({ projectId: PROJECT_A });
  });

  test("useClipboardRegion returns null when sessionStorage is empty", () => {
    const { result } = renderHook(() => useClipboardRegion(PROJECT_A));
    expect(result.current).toBeNull();
  });

  test("useClipboardRegion re-renders when set fires", () => {
    const { result, rerender } = renderHook(() =>
      useClipboardRegion(PROJECT_A),
    );
    expect(result.current).toBeNull();
    setClipboardRegion(PROJECT_A, sampleRegion);
    rerender();
    expect(result.current).not.toBeNull();
    expect(result.current?.paddingPx).toBe(4);
  });

  test("useClipboardRegion ignores events for other projects", () => {
    const { result, rerender } = renderHook(() =>
      useClipboardRegion(PROJECT_A),
    );
    setClipboardRegion(PROJECT_B, sampleRegion);
    rerender();
    expect(result.current).toBeNull();
  });
});
