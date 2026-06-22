import { describe, expect, it } from "vitest";

import {
  buildIgnoreAreasPayload,
  hasUnsavedIgnoreChanges,
} from "../src/components/diff-viewer/ignore-area-payload";
import type { IgnoreArea } from "../src/components/diff-viewer/useViewerStore";

const region = (over: Partial<IgnoreArea> & { id: string }): IgnoreArea => ({
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  viewport: "1280x720",
  paddingPx: 0,
  kind: "ignore",
  ...over,
});

const emptyState = {
  savedRunIgnoreAreas: [] as IgnoreArea[],
  savedVariationIgnoreAreas: [] as IgnoreArea[],
  draftIgnoreAreas: [] as IgnoreArea[],
  markedForDeletion: new Set<string>(),
  paddingOverrides: new Map<string, number>(),
  kindOverrides: new Map<
    string,
    { kind: IgnoreArea["kind"]; pattern?: string }
  >(),
  thresholdOverrides: new Map<string, number | undefined>(),
  selectorOverrides: new Map<string, string | null>(),
};

describe("buildIgnoreAreasPayload", () => {
  it("maps a drawn draft into the wire payload (variation scope)", () => {
    const payload = buildIgnoreAreasPayload(
      {
        ...emptyState,
        draftIgnoreAreas: [
          region({ id: "d1", x: 10, y: 20, width: 100, height: 50 }),
        ],
      },
      "variation",
    );
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      viewport: "1280x720",
      kind: "ignore",
    });
  });

  it("keeps surviving saved regions and drops those marked for deletion", () => {
    const payload = buildIgnoreAreasPayload(
      {
        ...emptyState,
        savedVariationIgnoreAreas: [
          region({ id: "s1", x: 1 }),
          region({ id: "s2", x: 2 }),
        ],
        markedForDeletion: new Set(["s2"]),
      },
      "variation",
    );
    expect(payload).toHaveLength(1);
    expect(payload[0]?.x).toBe(1);
  });

  it("selects run-scope saved regions when scope is run", () => {
    const payload = buildIgnoreAreasPayload(
      {
        ...emptyState,
        savedRunIgnoreAreas: [region({ id: "r1", x: 7 })],
        savedVariationIgnoreAreas: [region({ id: "v1", x: 9 })],
      },
      "run",
    );
    expect(payload).toHaveLength(1);
    expect(payload[0]?.x).toBe(7);
  });

  it("applies a padding override onto a surviving saved region", () => {
    const payload = buildIgnoreAreasPayload(
      {
        ...emptyState,
        savedVariationIgnoreAreas: [region({ id: "s1", paddingPx: 4 })],
        paddingOverrides: new Map([["s1", 12]]),
      },
      "variation",
    );
    expect(payload[0]?.paddingPx).toBe(12);
  });
});

describe("hasUnsavedIgnoreChanges", () => {
  it("is false for a clean state", () => {
    expect(hasUnsavedIgnoreChanges(emptyState)).toBe(false);
  });

  it("is true when there is a drawn draft", () => {
    expect(
      hasUnsavedIgnoreChanges({
        ...emptyState,
        draftIgnoreAreas: [region({ id: "d1" })],
      }),
    ).toBe(true);
  });

  it("is true when a saved region is marked for deletion", () => {
    expect(
      hasUnsavedIgnoreChanges({
        ...emptyState,
        markedForDeletion: new Set(["s1"]),
      }),
    ).toBe(true);
  });
});
