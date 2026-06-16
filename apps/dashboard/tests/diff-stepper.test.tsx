import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import type { DiffRegion } from "../src/components/diff-viewer/layers/regionTypes";
import { useDiffStepper } from "../src/components/diff-viewer/useDiffStepper";
import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";

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
  useViewerStore.setState({
    selectedRegionId: null,
    focusBbox: null,
    hideDisplacement: false,
  });
});

describe("useDiffStepper", () => {
  test("count reflects ordered regions", () => {
    const { result } = renderHook(() => useDiffStepper(regions));
    expect(result.current.count).toBe(2);
  });

  test("next selects the worst region first, then sets focusBbox", () => {
    const { result } = renderHook(() => useDiffStepper(regions));
    act(() => result.current.next());
    const s = useViewerStore.getState();
    expect(s.selectedRegionId).toBe("a");
    expect(s.focusBbox).toEqual({ x: 0, y: 0, width: 9, height: 9 });
    expect(result.current.index).toBe(0);
  });

  test("next wraps around", () => {
    useViewerStore.setState({ selectedRegionId: "b" });
    const { result } = renderHook(() => useDiffStepper(regions));
    act(() => result.current.next());
    expect(useViewerStore.getState().selectedRegionId).toBe("a");
  });
});
