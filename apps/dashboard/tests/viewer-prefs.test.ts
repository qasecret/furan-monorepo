import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DEFAULT_VIEWER_PREFS,
  prefsKey,
  readViewerPrefs,
  useViewerPrefs,
  writeViewerPrefs,
} from "../src/components/diff-viewer/viewer-prefs";

/** A Storage over a Map, holding `seed`. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

/** A storage holding `value` (JSON-encoded unless it is a string) for u1. */
function storedForU1(value: unknown): Storage {
  return memoryStorage({
    [prefsKey("u1")]: typeof value === "string" ? value : JSON.stringify(value),
  });
}

describe("prefsKey", () => {
  test("is versioned and per user", () => {
    expect(prefsKey("u1")).toBe("furan:viewer:prefs:v1:u1");
  });
});

describe("readViewerPrefs", () => {
  test("an empty store gives the defaults", () => {
    expect(readViewerPrefs("u1", memoryStorage())).toEqual(
      DEFAULT_VIEWER_PREFS,
    );
  });

  test("the defaults are the spec's", () => {
    expect(DEFAULT_VIEWER_PREFS).toEqual({
      mode: "side-by-side",
      opacity: 0.5,
      highlight: true,
      hideDisplacement: false,
      railWidth: 320,
      railCollapsed: false,
      railTab: "info",
    });
  });

  test("falls back field by field, keeping the good ones", () => {
    const prefs = readViewerPrefs(
      "u1",
      storedForU1({
        mode: "swipe",
        opacity: "x",
        railWidth: 9999,
        highlight: false,
      }),
    );
    expect(prefs).toEqual({
      ...DEFAULT_VIEWER_PREFS,
      mode: "swipe",
      highlight: false,
    });
  });

  test.each([279, 561, -1, "400", null])(
    "a rail width of %j falls back to 320",
    (railWidth) => {
      expect(readViewerPrefs("u1", storedForU1({ railWidth })).railWidth).toBe(
        320,
      );
    },
  );

  test.each([280, 400, 560])("a rail width of %j is kept", (railWidth) => {
    expect(readViewerPrefs("u1", storedForU1({ railWidth })).railWidth).toBe(
      railWidth,
    );
  });

  test.each([
    ["an unknown mode", { mode: "difference" }],
    ["an opacity above 1", { opacity: 1.5 }],
    ["an unknown tab", { railTab: "regions" }],
    ["a string for a switch", { railCollapsed: "yes" }],
  ])("%s falls back to its default", (_label, stored) => {
    expect(readViewerPrefs("u1", storedForU1(stored))).toEqual(
      DEFAULT_VIEWER_PREFS,
    );
  });

  test.each(["{not json", "42", "[1,2]", "null"])(
    "%j stored gives the defaults",
    (raw) => {
      expect(readViewerPrefs("u1", storedForU1(raw))).toEqual(
        DEFAULT_VIEWER_PREFS,
      );
    },
  );

  test("a getItem that throws gives the defaults", () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
    expect(readViewerPrefs("u1", storage)).toEqual(DEFAULT_VIEWER_PREFS);
  });

  test("no storage at all gives the defaults", () => {
    expect(readViewerPrefs("u1", null)).toEqual(DEFAULT_VIEWER_PREFS);
  });
});

describe("writeViewerPrefs", () => {
  test("swallows a setItem that throws (quota)", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    expect(() =>
      writeViewerPrefs("u1", DEFAULT_VIEWER_PREFS, storage),
    ).not.toThrow();
  });

  test("each user keeps their own preferences", () => {
    const storage = memoryStorage();
    writeViewerPrefs(
      "u1",
      { ...DEFAULT_VIEWER_PREFS, mode: "overlay" },
      storage,
    );
    writeViewerPrefs("u2", { ...DEFAULT_VIEWER_PREFS, mode: "diff" }, storage);
    expect(readViewerPrefs("u1", storage).mode).toBe("overlay");
    expect(readViewerPrefs("u2", storage).mode).toBe("diff");
  });
});

describe("useViewerPrefs", () => {
  const prefs = () => useViewerPrefs.getState().prefs;

  beforeEach(() => {
    localStorage.clear();
    useViewerPrefs.setState({
      userId: null,
      prefs: DEFAULT_VIEWER_PREFS,
      previousMode: "side-by-side",
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("hydrate reads the user's stored preferences", () => {
    writeViewerPrefs("u1", { ...DEFAULT_VIEWER_PREFS, mode: "overlay" });
    useViewerPrefs.getState().hydrate("u1");
    expect(useViewerPrefs.getState().userId).toBe("u1");
    expect(prefs().mode).toBe("overlay");
  });

  test("hydrate reads once per user: a remount keeps a change not yet written", () => {
    useViewerPrefs.getState().hydrate("u1");
    useViewerPrefs.getState().set("opacity", 0.7, { persist: false });
    useViewerPrefs.getState().hydrate("u1");
    expect(prefs().opacity).toBe(0.7);
  });

  test("another user's hydrate reads theirs", () => {
    writeViewerPrefs("u2", { ...DEFAULT_VIEWER_PREFS, mode: "diff" });
    useViewerPrefs.getState().hydrate("u1");
    useViewerPrefs.getState().set("mode", "overlay");
    useViewerPrefs.getState().hydrate("u2");
    expect(prefs().mode).toBe("diff");
  });

  test("set without persisting writes nothing; persisting writes once", () => {
    useViewerPrefs.getState().hydrate("u1");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    useViewerPrefs.getState().set("opacity", 0.7, { persist: false });
    expect(prefs().opacity).toBe(0.7);
    expect(setItem).not.toHaveBeenCalled();

    useViewerPrefs.getState().set("opacity", 0.7, { persist: true });
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(prefsKey("u1"), expect.any(String));
    expect(readViewerPrefs("u1").opacity).toBe(0.7);
  });

  test("set persists by default", () => {
    useViewerPrefs.getState().hydrate("u1");
    useViewerPrefs.getState().set("highlight", false);
    expect(readViewerPrefs("u1").highlight).toBe(false);
  });

  test("with no user, a change holds in memory and nothing is written", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    useViewerPrefs.getState().set("mode", "overlay");
    expect(prefs().mode).toBe("overlay");
    expect(setItem).not.toHaveBeenCalled();
  });

  test("a mode left for another becomes the way back from diff", () => {
    useViewerPrefs.getState().set("mode", "overlay");
    useViewerPrefs.getState().set("mode", "diff");
    expect(useViewerPrefs.getState().previousMode).toBe("overlay");
    // Leaving diff is no way back to it.
    useViewerPrefs.getState().set("mode", "swipe");
    expect(useViewerPrefs.getState().previousMode).toBe("overlay");
  });
});
