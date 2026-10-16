import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import type { DiffRegion } from "../src/components/diff-viewer/layers/regionTypes";
import { useDiffStepper } from "../src/components/diff-viewer/useDiffStepper";
import { useViewState } from "../src/components/diff-viewer/view-state";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
} from "../src/components/diff-viewer/viewer-prefs";

const regions: DiffRegion[] = [
  {
    id: "a",
    severity: "breaking",
    category: "text",
    bbox: { x: 0, y: 0, width: 9, height: 9 },
    description: "",
    source: "l2",
  },
  {
    id: "b",
    severity: "minor",
    category: "text",
    bbox: { x: 1, y: 1, width: 2, height: 2 },
    description: "",
    source: "l2",
  },
];

beforeEach(() => {
  useViewState.setState({
    selectedRegionId: null,
    focusBbox: null,
    showSuppressed: false,
  });
  useViewerPrefs.setState({ prefs: DEFAULT_VIEWER_PREFS });
});

describe("useDiffStepper", () => {
  test("count reflects ordered regions", () => {
    const { result } = renderHook(() => useDiffStepper(regions));
    expect(result.current.count).toBe(2);
  });

  test("next selects the worst region first, then sets focusBbox", () => {
    const { result } = renderHook(() => useDiffStepper(regions));
    act(() => result.current.next());
    const s = useViewState.getState();
    expect(s.selectedRegionId).toBe("a");
    expect(s.focusBbox).toEqual({ x: 0, y: 0, width: 9, height: 9 });
    expect(result.current.index).toBe(0);
  });

  test("next wraps around", () => {
    useViewState.setState({ selectedRegionId: "b" });
    const { result } = renderHook(() => useDiffStepper(regions));
    act(() => result.current.next());
    expect(useViewState.getState().selectedRegionId).toBe("a");
  });

  test("two next() calls in one batch advance two steps (no stale index)", () => {
    const { result } = renderHook(() => useDiffStepper(regions));
    act(() => {
      result.current.next();
      result.current.next();
    });
    expect(useViewState.getState().selectedRegionId).toBe("b");
  });
});

describe("useDiffStepper follows Show suppressed (T7, R10)", () => {
  // A finding, and an audit row bigger than it, which sorts first when shown.
  const withAudit: DiffRegion[] = [
    {
      id: "finding",
      severity: "major",
      category: "text",
      bbox: { x: 0, y: 0, width: 4, height: 4 },
      description: "",
      source: "l1_pixel",
    },
    {
      id: "audit",
      severity: "major",
      category: "text",
      bbox: { x: 10, y: 10, width: 20, height: 20 },
      description: "",
      source: "dynamic_text",
    },
  ];

  test("with it off, n and p skip the audit rows, as the list and the canvas do", () => {
    const { result } = renderHook(() => useDiffStepper(withAudit));
    expect(result.current.count).toBe(1);
    act(() => result.current.next());
    expect(useViewState.getState().selectedRegionId).toBe("finding");
    act(() => result.current.next());
    expect(useViewState.getState().selectedRegionId).toBe("finding");
  });

  test("with it on, n and p step through the audit rows the list and the canvas show", () => {
    const { result } = renderHook(() => useDiffStepper(withAudit));
    act(() => useViewState.getState().setShowSuppressed(true));
    expect(result.current.count).toBe(2);
    act(() => result.current.next());
    expect(useViewState.getState().selectedRegionId).toBe("audit");
    expect(result.current.index).toBe(0);
    act(() => result.current.next());
    expect(useViewState.getState().selectedRegionId).toBe("finding");
    act(() => result.current.prev());
    expect(useViewState.getState().selectedRegionId).toBe("audit");
  });
});
