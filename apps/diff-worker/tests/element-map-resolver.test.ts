import { describe, expect, it, vi } from "vitest";

import {
  resolveRegionBbox,
  type ElementMap,
  type ResolutionOutcome,
} from "../src/element-map-resolver.js";

const mockLogger = {
  warn: vi.fn(),
};

function makeRegion(
  overrides: Partial<{
    x: number;
    y: number;
    width: number;
    height: number;
    selector?: string;
  }> = {},
) {
  return {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    paddingPx: 0,
    kind: "ignore" as const,
    ...overrides,
  };
}

const BOUNDS = { width: 1280, height: 720 };

function makeMap(
  elements: Record<
    string,
    { x: number; y: number; width: number; height: number }
  >,
): ElementMap {
  return { v: 1, elements, capturedAt: 1700000000000 };
}

describe("resolveRegionBbox", () => {
  it("returns resolved bbox + emits resolved when selector hits a valid bbox", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const map = makeMap({
      "#login": { x: 50, y: 60, width: 200, height: 80 },
    });
    const storage = {
      get: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(map))),
    };

    const result = await resolveRegionBbox(
      makeRegion({ selector: "#login" }),
      "candidate.elements.json",
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(result).toEqual({ x: 50, y: 60, width: 200, height: 80 });
    expect(outcomes).toEqual(["resolved"]);
  });

  it("returns stored bbox + emits no_selector when region has no selector", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const storage = { get: vi.fn() };

    const result = await resolveRegionBbox(
      makeRegion({ selector: undefined }),
      "candidate.elements.json",
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(outcomes).toEqual(["no_selector"]);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("returns stored bbox + emits no_map when candidate has no elementMapKey", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const storage = { get: vi.fn() };

    const result = await resolveRegionBbox(
      makeRegion({ selector: "#login" }),
      null,
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(outcomes).toEqual(["no_map"]);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it("returns stored bbox + emits selector_miss when selector not in map", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const map = makeMap({
      "#other": { x: 50, y: 60, width: 200, height: 80 },
    });
    const storage = {
      get: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(map))),
    };

    const result = await resolveRegionBbox(
      makeRegion({ selector: "#login" }),
      "candidate.elements.json",
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(outcomes).toEqual(["selector_miss"]);
  });

  it("returns stored bbox + emits invalid_resolved when resolved bbox is off-screen", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const map = makeMap({
      "#big": { x: 1200, y: 600, width: 500, height: 500 },
    });
    const storage = {
      get: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(map))),
    };

    const result = await resolveRegionBbox(
      makeRegion({ selector: "#big" }),
      "candidate.elements.json",
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(outcomes).toEqual(["invalid_resolved"]);
  });

  it("returns stored bbox + emits fetch_error when storage.get throws", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const storage = {
      get: vi.fn().mockRejectedValue(new Error("404 not found")),
    };

    const result = await resolveRegionBbox(
      makeRegion({ selector: "#login" }),
      "candidate.elements.json",
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(outcomes).toEqual(["fetch_error"]);
  });

  it("returns stored bbox + emits unknown_envelope when v != 1", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const storage = {
      get: vi
        .fn()
        .mockResolvedValue(
          Buffer.from(JSON.stringify({ v: 2, elements: {}, capturedAt: 0 })),
        ),
    };

    const result = await resolveRegionBbox(
      makeRegion({ selector: "#login" }),
      "candidate.elements.json",
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(outcomes).toEqual(["unknown_envelope"]);
  });

  it("returns stored bbox + emits fetch_error when JSON is malformed", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const storage = {
      get: vi.fn().mockResolvedValue(Buffer.from("not valid json{")),
    };

    const result = await resolveRegionBbox(
      makeRegion({ selector: "#login" }),
      "candidate.elements.json",
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(result).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(outcomes).toEqual(["fetch_error"]);
  });

  it("caches the fetched map across calls — second call does not fetch", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const map = makeMap({
      "#a": { x: 0, y: 0, width: 50, height: 50 },
      "#b": { x: 100, y: 100, width: 50, height: 50 },
    });
    const storage = {
      get: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(map))),
    };
    const cache = new Map();

    await resolveRegionBbox(
      makeRegion({ selector: "#a" }),
      "candidate.elements.json",
      BOUNDS,
      cache,
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );
    await resolveRegionBbox(
      makeRegion({ selector: "#b" }),
      "candidate.elements.json",
      BOUNDS,
      cache,
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["resolved", "resolved"]);
  });

  it("caches a failed fetch as null — second call short-circuits without re-emitting", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const storage = {
      get: vi.fn().mockRejectedValue(new Error("404")),
    };
    const cache = new Map();

    await resolveRegionBbox(
      makeRegion({ selector: "#a" }),
      "candidate.elements.json",
      BOUNDS,
      cache,
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );
    await resolveRegionBbox(
      makeRegion({ selector: "#b" }),
      "candidate.elements.json",
      BOUNDS,
      cache,
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["fetch_error"]);
  });

  it("accepts a sub-pixel-overflow bbox within +1 tolerance", async () => {
    const outcomes: ResolutionOutcome[] = [];
    const map = makeMap({
      "#right-edge": { x: 1180, y: 0, width: 101, height: 50 },
    });
    const storage = {
      get: vi.fn().mockResolvedValue(Buffer.from(JSON.stringify(map))),
    };

    const result = await resolveRegionBbox(
      makeRegion({ selector: "#right-edge" }),
      "candidate.elements.json",
      BOUNDS,
      new Map(),
      { storage, logger: mockLogger, onOutcome: (o) => outcomes.push(o) },
    );

    expect(outcomes).toEqual(["resolved"]);
    expect(result).toEqual({ x: 1180, y: 0, width: 101, height: 50 });
  });
});
