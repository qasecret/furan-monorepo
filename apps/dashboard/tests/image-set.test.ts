import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __viewerBitmapCache,
  BITMAP_CACHE_LIMITS,
  createBitmapCache,
  decodeImage,
  storageUrl,
  useImageSet,
  type ImageSetRequest,
  type LoadedImage,
} from "@/components/diff-viewer/image-set";
import { browserEnv } from "@/lib/env";

// -- fakes ------------------------------------------------------------------

type FakeBitmap = ImageBitmap & { close: ReturnType<typeof vi.fn> };

function fakeBitmap(w: number, h: number): FakeBitmap {
  return { width: w, height: h, close: vi.fn() } as unknown as FakeBitmap;
}

function loaded(
  key: string,
  w: number,
  h: number,
): LoadedImage & {
  bitmap: FakeBitmap;
} {
  return { key, bitmap: fakeBitmap(w, h), size: { w, h } };
}

/** One in-flight `fetch`, answered (or not) by the test. */
interface Call {
  key: string;
  init: RequestInit;
  respond(status?: number): void;
}

const keyOfBlob = new WeakMap<Blob, string>();

let calls: Call[];
let sizes: Map<string, { w: number; h: number }>;
let bitmaps: Map<string, FakeBitmap>;
let honourAbort: boolean;
let createImageBitmapMock: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let prefix: string;
let counter = 0;

/** A key no other test uses, so the shared module cache cannot leak between them. */
const k = (name: string): string => `${prefix}-${name}`;

const req = (
  baseline: string | null,
  current: string | null,
  diff: string | null,
): ImageSetRequest => ({ baseline, current, diff });

const stepReq = (id: string): ImageSetRequest =>
  req(k(`${id}b`), k(`${id}c`), k(`${id}d`));

function fetchedKeys(): string[] {
  return calls.map((c) => c.key);
}

function callsFor(key: string): Call[] {
  return calls.filter((c) => c.key === key);
}

const restorers: Array<() => void> = [];

/** Replace `HTMLImageElement.prototype.decode` (jsdom may not define it). */
function stubImageDecode(
  impl: (this: HTMLImageElement) => Promise<void>,
): void {
  const proto = HTMLImageElement.prototype;
  const had = Object.prototype.hasOwnProperty.call(proto, "decode");
  const original = proto.decode;
  Object.defineProperty(proto, "decode", {
    configurable: true,
    writable: true,
    value: impl,
  });
  restorers.push(() => {
    if (had) {
      Object.defineProperty(proto, "decode", {
        configurable: true,
        writable: true,
        value: original,
      });
    } else {
      delete (proto as { decode?: unknown }).decode;
    }
  });
}

/** Let promise chains and React effects run to a standstill. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Answer every fetch that is still waiting for one. */
async function respondAll(status = 200): Promise<void> {
  await act(async () => {
    for (const c of calls) c.respond(status);
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  counter += 1;
  prefix = `t${counter}`;
  calls = [];
  sizes = new Map();
  bitmaps = new Map();
  honourAbort = true;

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit) => {
      const key = decodeURIComponent(input.split("/").pop() ?? "");
      return new Promise<Response>((resolve, reject) => {
        const call: Call = {
          key,
          init,
          respond: (status = 200) => {
            const blob = new Blob(["x"]);
            keyOfBlob.set(blob, key);
            resolve({
              ok: status >= 200 && status < 300,
              status,
              statusText: status === 200 ? "OK" : "Not Found",
              blob: () => Promise.resolve(blob),
            } as unknown as Response);
          },
        };
        calls.push(call);
        init.signal?.addEventListener("abort", () => {
          if (honourAbort) reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }),
  );

  createImageBitmapMock = vi.fn((src: Blob) => {
    const key = keyOfBlob.get(src) ?? "unknown";
    const s = sizes.get(key) ?? { w: 100, h: 50 };
    const bm = fakeBitmap(s.w, s.h);
    bitmaps.set(key, bm);
    return Promise.resolve(bm);
  });
  vi.stubGlobal("createImageBitmap", createImageBitmapMock);

  // jsdom has no object URLs; a spy proves nobody asks for one.
  createObjectURL = vi.fn(() => "blob:never");
  URL.createObjectURL =
    createObjectURL as unknown as typeof URL.createObjectURL;
});

afterEach(() => {
  cleanup();
  while (restorers.length > 0) restorers.pop()!();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
});

function mount(
  initial: ImageSetRequest,
  prefetch: readonly ImageSetRequest[] = [],
) {
  return renderHook(
    (p: { r: ImageSetRequest; ahead: readonly ImageSetRequest[] }) =>
      useImageSet(p.r, p.ahead),
    { initialProps: { r: initial, ahead: prefetch } },
  );
}

// -- storageUrl / decodeImage -----------------------------------------------

describe("storageUrl", () => {
  it("is the storage proxy under the api base, with the key encoded", () => {
    expect(storageUrl("abc")).toBe(
      `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/storage/abc`,
    );
    expect(storageUrl("a/b c")).toBe(
      `${browserEnv.NEXT_PUBLIC_API_URL}/api/v1/storage/a%2Fb%20c`,
    );
  });
});

describe("decodeImage", () => {
  const blob = (): Blob => new Blob(["png"]);

  it("decodes the blob directly when it can", async () => {
    const bm = fakeBitmap(3, 4);
    createImageBitmapMock.mockResolvedValueOnce(bm);
    const b = blob();
    await expect(decodeImage(b)).resolves.toBe(bm);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    expect(createImageBitmapMock).toHaveBeenCalledWith(b);
  });

  describe("when createImageBitmap rejects the blob", () => {
    let decoded: string[];

    beforeEach(() => {
      decoded = [];
      stubImageDecode(function (this: HTMLImageElement) {
        decoded.push(this.src);
        return Promise.resolve();
      });
    });

    it("falls back to an image element, then bitmaps that", async () => {
      const bm = fakeBitmap(7, 9);
      createImageBitmapMock
        .mockRejectedValueOnce(new Error("InvalidStateError"))
        .mockResolvedValueOnce(bm);
      await expect(decodeImage(blob())).resolves.toBe(bm);
      expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
      expect(createImageBitmapMock.mock.calls[1]![0]).toBeInstanceOf(
        HTMLImageElement,
      );
      // A data: URL, so the fallback needs no object URL either.
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toMatch(/^data:/);
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it("rejects when the image element cannot decode it either", async () => {
      createImageBitmapMock.mockRejectedValueOnce(new Error("first"));
      stubImageDecode(() => Promise.reject(new Error("EncodingError")));
      await expect(decodeImage(blob())).rejects.toThrow("EncodingError");
      expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    });

    it("rejects when bitmapping the decoded image fails too", async () => {
      createImageBitmapMock
        .mockRejectedValueOnce(new Error("first"))
        .mockRejectedValueOnce(new Error("second"));
      await expect(decodeImage(blob())).rejects.toThrow("second");
    });
  });
});

// -- the cache --------------------------------------------------------------

describe("createBitmapCache", () => {
  it("evicts the oldest past the entry limit and closes only that bitmap", () => {
    const cache = createBitmapCache(BITMAP_CACHE_LIMITS);
    const imgs = Array.from({ length: 13 }, (_, i) => loaded(`k${i}`, 10, 10));
    for (const img of imgs) cache.set(img);

    expect(cache.size()).toBe(12);
    expect(cache.get("k0")).toBeUndefined();
    expect(imgs[0]!.bitmap.close).toHaveBeenCalledTimes(1);
    for (const img of imgs.slice(1)) {
      expect(cache.get(img.key)).toBe(img);
      expect(img.bitmap.close).not.toHaveBeenCalled();
    }
  });

  it("counts a read as use: the least recently used goes first", () => {
    const cache = createBitmapCache({ maxEntries: 2, maxBytes: 1e9 });
    const a = loaded("a", 10, 10);
    const b = loaded("b", 10, 10);
    const c = loaded("c", 10, 10);
    cache.set(a);
    cache.set(b);
    cache.get("a");
    cache.set(c);

    expect(cache.get("a")).toBe(a);
    expect(cache.get("b")).toBeUndefined();
    expect(b.bitmap.close).toHaveBeenCalledTimes(1);
    expect(a.bitmap.close).not.toHaveBeenCalled();
  });

  it("evicts past the byte limit, estimating w x h x 4", () => {
    const cache = createBitmapCache(BITMAP_CACHE_LIMITS);
    const a = loaded("a", 10000, 5000); // 200 MB each
    const b = loaded("b", 10000, 5000);
    const c = loaded("c", 10000, 5000);
    cache.set(a);
    cache.set(b);
    expect(cache.bytes()).toBe(400_000_000);
    expect(cache.size()).toBe(2);
    cache.set(c);

    expect(cache.size()).toBe(2);
    expect(cache.bytes()).toBe(400_000_000);
    expect(cache.get("a")).toBeUndefined();
    expect(a.bitmap.close).toHaveBeenCalledTimes(1);
    expect(b.bitmap.close).not.toHaveBeenCalled();
    expect(c.bitmap.close).not.toHaveBeenCalled();
  });

  it("keeps an image bigger than the whole budget rather than closing what it just stored", () => {
    const cache = createBitmapCache({ maxEntries: 12, maxBytes: 1000 });
    const small = loaded("small", 2, 2);
    const huge = loaded("huge", 100, 100);
    cache.set(small);
    cache.set(huge);

    expect(cache.get("huge")).toBe(huge);
    expect(huge.bitmap.close).not.toHaveBeenCalled();
    expect(small.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("owns what it is given: a second bitmap for a held key is closed, the held one stays", () => {
    const cache = createBitmapCache(BITMAP_CACHE_LIMITS);
    const first = loaded("a", 10, 10);
    const second = loaded("a", 10, 10);
    cache.set(first);
    cache.set(second);

    expect(cache.get("a")).toBe(first);
    expect(cache.size()).toBe(1);
    expect(cache.bytes()).toBe(400);
    expect(first.bitmap.close).not.toHaveBeenCalled();
    expect(second.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("tracks bytes down as entries leave", () => {
    const cache = createBitmapCache({ maxEntries: 1, maxBytes: 1e9 });
    cache.set(loaded("a", 10, 10));
    cache.set(loaded("b", 20, 20));
    expect(cache.bytes()).toBe(1600);
    expect(cache.size()).toBe(1);
  });
});

// -- the hook ---------------------------------------------------------------

describe("useImageSet: one fetch per key", () => {
  it("fetches each key once, with credentials, and decodes it into a bitmap", async () => {
    sizes.set(k("c"), { w: 320, h: 200 });
    const { result } = mount(req(k("b"), k("c"), k("d")));

    expect(result.current.status).toBe("loading");
    expect(fetchedKeys().sort()).toEqual([k("b"), k("c"), k("d")]);
    for (const c of calls) {
      expect(c.init.credentials).toBe("include");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetch).toHaveBeenCalledWith(storageUrl(k("c")), expect.anything());

    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const { images, failed } = result.current;
    expect(failed).toEqual({});
    expect(images.current?.key).toBe(k("c"));
    expect(images.current?.bitmap).toBe(bitmaps.get(k("c")));
    expect(images.current?.size).toEqual({ w: 320, h: 200 });
    expect(images.baseline?.size).toEqual({ w: 100, h: 50 });
    expect(images.diff?.key).toBe(k("d"));
    expect(createImageBitmapMock).toHaveBeenCalledTimes(3);
  });

  it("makes no more fetches on re-render or on remount with the same keys", async () => {
    const r = req(k("b"), k("c"), k("d"));
    const first = mount(r);
    await respondAll();
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    expect(calls).toHaveLength(3);

    first.rerender({ r: { ...r }, ahead: [] });
    await settle();
    first.unmount();

    const second = mount({ ...r });
    // Straight from the cache: ready on the first render, nothing fetched.
    expect(second.result.current.status).toBe("ready");
    expect(second.result.current.images.current?.bitmap).toBe(
      bitmaps.get(k("c")),
    );
    await settle();
    expect(calls).toHaveLength(3);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(3);
  });

  it("makes one fetch per key under StrictMode's mount, unmount, mount", async () => {
    const { result } = renderHook(() => useImageSet(stepReq("S")), {
      wrapper: StrictMode,
    });
    await settle();
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => !(c.init.signal as AbortSignal).aborted)).toBe(
      true,
    );

    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(Object.keys(result.current.images).sort()).toEqual([
      "baseline",
      "current",
      "diff",
    ]);
  });

  it("makes one fetch when two roles share a key", async () => {
    const { result } = mount(req(k("same"), k("same"), k("d")));
    expect(fetchedKeys().sort()).toEqual([k("d"), k("same")]);

    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.images.baseline).toBeDefined();
    expect(result.current.images.baseline).toBe(result.current.images.current);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
  });

  it("asks only for the roles that have a key", async () => {
    const { result } = mount(req(null, k("c"), null));
    expect(fetchedKeys()).toEqual([k("c")]);

    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(Object.keys(result.current.images)).toEqual(["current"]);
    expect(result.current.failed).toEqual({});
  });

  it("is ready at once when nothing is requested", () => {
    const { result } = mount(req(null, null, null));
    expect(result.current.status).toBe("ready");
    expect(calls).toHaveLength(0);
  });

  it("never makes an object URL", async () => {
    const { result } = mount(req(k("b"), k("c"), k("d")), [stepReq("n")]);
    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await respondAll();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("useImageSet: the shared bitmap cache", () => {
  it("fills the module cache, which closes what it evicts", async () => {
    const { result } = mount(req(null, k("first"), null));
    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = bitmaps.get(k("first"))!;
    expect(__viewerBitmapCache.get(k("first"))?.bitmap).toBe(first);

    // Twelve more distinct keys push the oldest out.
    for (let i = 0; i < 12; i++) {
      const m = mount(req(null, k(`more${i}`), null));
      await respondAll();
      await waitFor(() => expect(m.result.current.status).toBe("ready"));
      m.unmount();
    }
    expect(__viewerBitmapCache.get(k("first"))).toBeUndefined();
    expect(first.close).toHaveBeenCalledTimes(1);
  });
});

describe("useImageSet: stale work", () => {
  it("aborts the old step's in-flight fetches when the step changes", async () => {
    const { rerender } = mount(stepReq("A"));
    const a = calls.map((c) => c.init.signal as AbortSignal);
    expect(a).toHaveLength(3);
    expect(a.every((s) => !s.aborted)).toBe(true);

    rerender({ r: stepReq("B"), ahead: [] });
    await settle();

    expect(a.every((s) => s.aborted)).toBe(true);
    const b = calls.filter((c) => c.key.startsWith(k("B")));
    expect(b).toHaveLength(3);
    expect(b.every((c) => !(c.init.signal as AbortSignal).aborted)).toBe(true);
  });

  it("aborts on unmount", async () => {
    const { unmount } = mount(stepReq("A"));
    const a = calls.map((c) => c.init.signal as AbortSignal);
    unmount();
    await settle();
    expect(a.every((s) => s.aborted)).toBe(true);
  });

  it("never shows a response that arrives after the step changed", async () => {
    honourAbort = false; // the network answers A anyway, late
    const { result, rerender } = mount(stepReq("A"));
    const lateA = [...calls];

    rerender({ r: stepReq("B"), ahead: [] });
    await settle();
    expect(result.current.images).toEqual({});

    await act(async () => {
      for (const c of lateA) c.respond();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.images).toEqual({});
    expect(result.current.status).toBe("loading");
    // Nobody wants step A any more: its bytes are not even decoded.
    expect(createImageBitmapMock).not.toHaveBeenCalled();

    await act(async () => {
      for (const c of calls.slice(lateA.length)) c.respond();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const shown = Object.values(result.current.images).map((i) => i.key);
    expect(shown.sort()).toEqual([k("Bb"), k("Bc"), k("Bd")]);
  });

  it("never shows a bitmap that finished decoding after the step changed, and keeps it in the cache", async () => {
    let finishDecode!: () => void;
    const lateBitmap = fakeBitmap(40, 40);
    createImageBitmapMock.mockImplementationOnce(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          finishDecode = () => resolve(lateBitmap);
        }),
    );
    const { result, rerender } = mount(req(null, k("Ac"), null));
    await act(async () => {
      callsFor(k("Ac"))[0]!.respond();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1); // decoding A

    rerender({ r: req(null, k("Bc"), null), ahead: [] });
    await settle();
    await act(async () => {
      finishDecode();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.images).toEqual({});
    // Decoded for its key, so the cache keeps it: nobody else closes it.
    expect(__viewerBitmapCache.get(k("Ac"))?.bitmap).toBe(lateBitmap);
    expect(lateBitmap.close).not.toHaveBeenCalled();
  });

  it("shows no image from the old step while the new one loads", async () => {
    const { result, rerender } = mount(stepReq("A"));
    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.images.current?.key).toBe(k("Ac"));

    rerender({ r: stepReq("B"), ahead: [] });
    expect(result.current.status).toBe("loading");
    expect(result.current.images).toEqual({});
  });
});

describe("useImageSet: failure and retry", () => {
  it("marks only the failed role and keeps the rest", async () => {
    const { result } = mount(req(k("b"), k("c"), k("d")));
    await act(async () => {
      callsFor(k("b"))[0]!.respond();
      callsFor(k("c"))[0]!.respond();
      callsFor(k("d"))[0]!.respond(404);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.failed).toEqual({ diff: true });
    expect(result.current.images.diff).toBeUndefined();
    expect(result.current.images.baseline?.key).toBe(k("b"));
    expect(result.current.images.current?.key).toBe(k("c"));
  });

  it("retry refetches only the failed role", async () => {
    const { result } = mount(req(k("b"), k("c"), k("d")));
    await act(async () => {
      callsFor(k("b"))[0]!.respond();
      callsFor(k("c"))[0]!.respond();
      callsFor(k("d"))[0]!.respond(404);
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.failed.diff).toBe(true));
    expect(calls).toHaveLength(3);

    act(() => result.current.retry("diff"));
    await settle();
    expect(calls).toHaveLength(4);
    expect(callsFor(k("d"))).toHaveLength(2);
    expect(result.current.status).toBe("loading");
    expect(result.current.failed).toEqual({});

    await act(async () => {
      callsFor(k("d"))[1]!.respond();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.failed).toEqual({});
    expect(result.current.images.diff?.key).toBe(k("d"));
    expect(calls).toHaveLength(4);
  });

  it("does not remember a failure: opening the step again asks again", async () => {
    const first = mount(req(null, null, k("d")));
    await respondAll(404);
    await waitFor(() => expect(first.result.current.failed.diff).toBe(true));
    first.unmount();

    const second = mount(req(null, null, k("d")));
    await settle();
    expect(callsFor(k("d"))).toHaveLength(2);
    expect(second.result.current.status).toBe("loading");
  });

  it("fails a role whose image no decoder will take", async () => {
    stubImageDecode(() => Promise.reject(new Error("EncodingError")));
    createImageBitmapMock.mockRejectedValue(new Error("bad png"));
    const { result } = mount(req(null, null, k("d")));
    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.failed).toEqual({ diff: true });
    expect(result.current.images).toEqual({});
  });

  it("uses the image-element fallback when the blob alone is refused", async () => {
    stubImageDecode(() => Promise.resolve());
    const bm = fakeBitmap(11, 13);
    createImageBitmapMock.mockImplementation((src: unknown) =>
      src instanceof Blob
        ? Promise.reject(new Error("InvalidStateError"))
        : Promise.resolve(bm),
    );
    const { result } = mount(req(null, null, k("d")));
    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.failed).toEqual({});
    expect(result.current.images.diff?.bitmap).toBe(bm);
    expect(result.current.images.diff?.size).toEqual({ w: 11, h: 13 });
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("useImageSet: prefetch", () => {
  it("fetches the adjacent steps only once the requested set has settled", async () => {
    const { result } = mount(stepReq("A"), [stepReq("N")]);
    expect(fetchedKeys().sort()).toEqual([k("Ab"), k("Ac"), k("Ad")]);

    await act(async () => {
      callsFor(k("Ab"))[0]!.respond();
      callsFor(k("Ac"))[0]!.respond();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.status).toBe("loading");
    expect(calls).toHaveLength(3); // diff still outstanding: no prefetch yet

    await act(async () => {
      callsFor(k("Ad"))[0]!.respond();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(calls).toHaveLength(6));
    expect(fetchedKeys().slice(3).sort()).toEqual([k("Nb"), k("Nc"), k("Nd")]);
  });

  it("starts prefetching when the requested set settles with a failure", async () => {
    const { result } = mount(req(null, null, k("Ad")), [stepReq("N")]);
    await respondAll(404);
    await waitFor(() => expect(result.current.failed.diff).toBe(true));
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(fetchedKeys().slice(1).sort()).toEqual([k("Nb"), k("Nc"), k("Nd")]);
  });

  it("is silent about a prefetch that fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = mount(stepReq("A"), [stepReq("N")]);
    await respondAll();
    await waitFor(() => expect(calls).toHaveLength(6));

    await respondAll(404);
    await settle();
    expect(result.current.failed).toEqual({});
    expect(result.current.status).toBe("ready");
    expect(Object.keys(result.current.images).sort()).toEqual([
      "baseline",
      "current",
      "diff",
    ]);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not refetch a key that is already cached or already requested", async () => {
    // Step N shares its baseline with A, and A's current is also asked for.
    const ahead = req(k("Ab"), k("Nc"), k("Ac"));
    const { result } = mount(stepReq("A"), [ahead]);
    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(callsFor(k("Nc"))).toHaveLength(1));
    await settle();

    expect(callsFor(k("Ab"))).toHaveLength(1);
    expect(callsFor(k("Ac"))).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it("does not refetch a prefetched key when the reviewer arrives at it", async () => {
    const { result, rerender } = mount(stepReq("A"), [stepReq("N")]);
    await respondAll();
    await waitFor(() => expect(calls).toHaveLength(6));
    await respondAll();
    await settle();
    expect(calls).toHaveLength(6);

    rerender({ r: stepReq("N"), ahead: [] });
    // Already decoded: ready on the very first render of the new step.
    expect(result.current.status).toBe("ready");
    expect(result.current.images.current?.key).toBe(k("Nc"));
    await settle();
    expect(calls).toHaveLength(6);
  });

  it("lets the reviewer arrive at a step whose prefetch is still in flight, without a second fetch", async () => {
    const { result, rerender } = mount(stepReq("A"), [stepReq("N")]);
    await respondAll();
    await waitFor(() => expect(calls).toHaveLength(6));
    const prefetches = calls.slice(3);
    const signals = prefetches.map((c) => c.init.signal as AbortSignal);

    // Move to N while its images are still on the wire.
    rerender({ r: stepReq("N"), ahead: [] });
    await settle();
    expect(calls).toHaveLength(6);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    expect(result.current.status).toBe("loading");

    await act(async () => {
      for (const c of prefetches) c.respond();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(
      Object.values(result.current.images)
        .map((i) => i.key)
        .sort(),
    ).toEqual([k("Nb"), k("Nc"), k("Nd")]);
  });

  it("aborts a prefetch the new step no longer wants", async () => {
    const { rerender } = mount(stepReq("A"), [stepReq("N")]);
    await respondAll();
    await waitFor(() => expect(calls).toHaveLength(6));
    const signals = calls.slice(3).map((c) => c.init.signal as AbortSignal);

    rerender({ r: stepReq("Z"), ahead: [] });
    await settle();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("does not restart a prefetch when the same keys arrive in a new array", async () => {
    const { rerender } = mount(stepReq("A"), [stepReq("N")]);
    await respondAll();
    await waitFor(() => expect(calls).toHaveLength(6));
    const signals = calls.slice(3).map((c) => c.init.signal as AbortSignal);

    rerender({ r: stepReq("A"), ahead: [stepReq("N")] });
    await settle();
    expect(calls).toHaveLength(6);
    expect(signals.every((s) => !s.aborted)).toBe(true);
  });

  it("keeps the images on screen open while prefetching pushes the cache past its limit", async () => {
    const aheads = [1, 2, 3, 4, 5].map((i) => stepReq(`P${i}`)); // 15 keys
    const { result } = mount(stepReq("A"), aheads);
    await respondAll();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(calls).toHaveLength(18));

    // Answer the prefetches one at a time, as they would arrive.
    for (const c of calls.slice(3)) {
      await act(async () => {
        c.respond();
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    await settle();

    expect(__viewerBitmapCache.size()).toBe(BITMAP_CACHE_LIMITS.maxEntries);
    for (const role of ["Ab", "Ac", "Ad"]) {
      expect(bitmaps.get(k(role))!.close).not.toHaveBeenCalled();
      expect(__viewerBitmapCache.get(k(role))).toBeDefined();
    }
    // 18 images came through a cache of 12: the six oldest prefetches left.
    const closed = [...bitmaps.entries()].filter(
      ([, b]) => b.close.mock.calls.length > 0,
    );
    expect(closed).toHaveLength(6);
    expect(closed.every(([key]) => key.startsWith(k("P")))).toBe(true);
  });
});
