import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/navigation: the hook reads the live search params and writes through
// router.replace. A mutable URLSearchParams stands in for the address bar.
const replaceMock = vi.fn();
let currentParams = new URLSearchParams();
let currentPath = "/inbox";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => currentParams,
  usePathname: () => currentPath,
}));

import {
  batchHref,
  parseReviewContext,
  serializeReviewContext,
  toBuildsListFilter,
  toRunsListFilter,
  useReviewContext,
  type ReviewContext,
  type ReviewStatus,
} from "@/lib/review-url";

const clean = (over: Partial<ReviewContext> = {}): ReviewContext => ({
  status: "needs-review",
  facets: {},
  ...over,
});

describe("parseReviewContext", () => {
  it("a clean URL is Needs review with no facets", () => {
    expect(parseReviewContext(new URLSearchParams())).toEqual(clean());
  });

  it("reads every param from a URLSearchParams", () => {
    const sp = new URLSearchParams(
      "status=failed&browser=chrome&viewport=1280x720&os=macOS&device=Pixel&branch=main&q=login",
    );
    expect(parseReviewContext(sp)).toEqual({
      status: "failed",
      facets: {
        browser: "chrome",
        viewport: "1280x720",
        os: "macOS",
        device: "Pixel",
      },
      branch: "main",
      q: "login",
    });
  });

  it("reads a Next searchParams record, taking the first of a repeated key", () => {
    expect(
      parseReviewContext({
        status: ["passed", "failed"],
        browser: "firefox",
        branch: undefined,
      }),
    ).toEqual(clean({ status: "passed", facets: { browser: "firefox" } }));
  });

  it("drops an unknown status without erroring", () => {
    expect(parseReviewContext(new URLSearchParams("status=bogus"))).toEqual(
      clean(),
    );
    // A build rollup status that is not a chip is unknown here too.
    expect(
      parseReviewContext(new URLSearchParams("status=unresolved")),
    ).toEqual(clean());
  });

  it("drops an empty facet", () => {
    expect(
      parseReviewContext(new URLSearchParams("browser=&os=macOS")),
    ).toEqual(clean({ facets: { os: "macOS" } }));
  });

  it("drops an oversize facet at the API's limits (browser/os/device 64, viewport 32)", () => {
    const at = (n: number) => "x".repeat(n);
    const ok = parseReviewContext(
      new URLSearchParams(
        `browser=${at(64)}&os=${at(64)}&device=${at(64)}&viewport=${at(32)}`,
      ),
    );
    expect(ok.facets).toEqual({
      browser: at(64),
      os: at(64),
      device: at(64),
      viewport: at(32),
    });
    const over = parseReviewContext(
      new URLSearchParams(
        `browser=${at(65)}&os=${at(65)}&device=${at(65)}&viewport=${at(33)}`,
      ),
    );
    expect(over.facets).toEqual({});
  });

  it("drops an empty or oversize branch and search text (200)", () => {
    expect(parseReviewContext(new URLSearchParams("branch=&q="))).toEqual(
      clean(),
    );
    expect(
      parseReviewContext(
        new URLSearchParams(`branch=${"b".repeat(201)}&q=${"q".repeat(201)}`),
      ),
    ).toEqual(clean());
    expect(
      parseReviewContext(
        new URLSearchParams(`branch=${"b".repeat(200)}&q=${"q".repeat(200)}`),
      ),
    ).toEqual(clean({ branch: "b".repeat(200), q: "q".repeat(200) }));
  });
});

describe("serializeReviewContext", () => {
  it("a clean context is the empty string", () => {
    expect(serializeReviewContext(clean())).toBe("");
    expect(serializeReviewContext({})).toBe("");
  });

  it("omits the default status but writes every other one", () => {
    expect(serializeReviewContext({ status: "needs-review" })).toBe("");
    expect(serializeReviewContext({ status: "failed" })).toBe("?status=failed");
    expect(serializeReviewContext({ status: "all" })).toBe("?status=all");
  });

  it("writes facets, branch and search in a fixed order", () => {
    expect(
      serializeReviewContext({
        q: "login page",
        branch: "feat/x",
        facets: { device: "Pixel 7", os: "Android", browser: "chrome" },
        status: "passed",
      }),
    ).toBe(
      "?status=passed&browser=chrome&os=Android&device=Pixel+7&branch=feat%2Fx&q=login+page",
    );
  });

  it("omits empty and invalid values", () => {
    expect(
      serializeReviewContext({
        facets: { browser: "", viewport: "v".repeat(33) },
        branch: "",
        q: "x".repeat(201),
        props: {},
      }),
    ).toBe("");
  });

  it("only writes the requested keys (facets covers all four facet params)", () => {
    const ctx = clean({
      status: "failed",
      facets: { browser: "chrome", viewport: "800x600" },
      branch: "main",
      q: "abc",
      props: { team: "web" },
    });
    expect(serializeReviewContext(ctx, ["status", "facets"])).toBe(
      "?status=failed&browser=chrome&viewport=800x600",
    );
    expect(serializeReviewContext(ctx, ["branch"])).toBe("?branch=main");
    expect(serializeReviewContext(ctx, [])).toBe("");
  });

  it("round-trips through parse", () => {
    const ctx: ReviewContext = {
      status: "running",
      facets: {
        browser: "chrome",
        viewport: "1280x720",
        os: "macOS 15",
        device: "Pixel 7 & co",
      },
      branch: "feat/a&b=c",
      q: "ünï côdé #1",
      props: { team: "web", env: "stage ing" },
    };
    const qs = serializeReviewContext(ctx);
    expect(parseReviewContext(new URLSearchParams(qs))).toEqual(ctx);
  });

  it("round-trips the default and an empty-facet context to the same clean context", () => {
    expect(
      parseReviewContext(new URLSearchParams(serializeReviewContext(clean()))),
    ).toEqual(clean());
  });
});

describe("props encoding", () => {
  it("round-trips key/value pairs, including awkward values", () => {
    const props = {
      team: "web",
      note: "a,b:c d%e&f=g",
      empty: "",
      "k.e-y_1": "ü",
    };
    const qs = serializeReviewContext({ props });
    expect(parseReviewContext(new URLSearchParams(qs)).props).toEqual(props);
  });

  it("is stable: sorted by key, whatever the insertion order", () => {
    const a = serializeReviewContext({ props: { b: "2", a: "1", c: "3" } });
    const b = serializeReviewContext({ props: { c: "3", a: "1", b: "2" } });
    expect(a).toBe(b);
    expect(new URLSearchParams(a).get("props")).toBe("a:1,b:2,c:3");
  });

  it("keeps one param, key:value pairs joined by commas, each side percent-encoded", () => {
    const qs = serializeReviewContext({ props: { note: "a,b:c" } });
    expect(new URLSearchParams(qs).get("props")).toBe("note:a%2Cb%3Ac");
  });

  it("omits props when empty", () => {
    expect(serializeReviewContext({ props: {} })).toBe("");
  });

  it("drops entries beyond the API's limits (key 1-64 of [A-Za-z0-9_.-], value <= 256)", () => {
    const sp = new URLSearchParams();
    sp.set(
      "props",
      [
        "ok:fine",
        `${"k".repeat(65)}:long-key`,
        "bad key:space",
        ":no-key",
        `big:${"v".repeat(257)}`,
        `edge:${"v".repeat(256)}`,
      ].join(","),
    );
    expect(parseReviewContext(sp).props).toEqual({
      ok: "fine",
      edge: "v".repeat(256),
    });
    expect(
      serializeReviewContext({
        props: { ok: "fine", [`${"k".repeat(65)}`]: "x", big: "v".repeat(257) },
      }),
    ).toBe(serializeReviewContext({ props: { ok: "fine" } }));
  });

  it("keeps at most 20 entries (the API's cap), by sorted key", () => {
    const props: Record<string, string> = {};
    for (let i = 0; i < 25; i++) props[`k${String(i).padStart(2, "0")}`] = "v";
    const parsed = parseReviewContext(
      new URLSearchParams(serializeReviewContext({ props })),
    ).props;
    expect(Object.keys(parsed ?? {})).toHaveLength(20);
    expect(Object.keys(parsed ?? {}).sort()[19]).toBe("k19");
  });

  it("ignores malformed entries and bad escapes instead of throwing", () => {
    const sp = new URLSearchParams();
    sp.set("props", "novalue,good:1,bad:%E0%A4%A,:,,");
    expect(parseReviewContext(sp).props).toEqual({ good: "1" });
    sp.set("props", ",,,");
    expect(parseReviewContext(sp).props).toBeUndefined();
  });

  it("an absent props param leaves props undefined", () => {
    expect(
      parseReviewContext(new URLSearchParams("status=all")).props,
    ).toBeUndefined();
  });
});

describe("toRunsListFilter", () => {
  const cases: Array<[ReviewStatus, object]> = [
    ["needs-review", { pending: true }],
    ["failed", { status: ["failed"] }],
    ["running", { status: ["running"] }],
    // "new" is a passed run with a baseline created; the batch rollup counts it.
    ["passed", { status: ["passed", "new"] }],
    ["all", {}],
  ];
  it.each(cases)("%s", (status, expected) => {
    expect(toRunsListFilter(clean({ status }))).toEqual(expected);
  });

  it("passes the environment facets through", () => {
    expect(
      toRunsListFilter(
        clean({
          status: "needs-review",
          facets: { browser: "chrome", viewport: "800x600", os: "macOS" },
        }),
      ),
    ).toEqual({
      pending: true,
      browser: "chrome",
      viewport: "800x600",
      os: "macOS",
    });
  });

  it("never sends branch, search or props (they are not run filters)", () => {
    const f = toRunsListFilter(
      clean({ branch: "main", q: "x", props: { a: "b" } }),
    );
    expect(f).toEqual({ pending: true });
  });
});

describe("toBuildsListFilter", () => {
  const cases: Array<[ReviewStatus, object]> = [
    ["needs-review", { needsReview: true }],
    ["failed", { status: "failed" }],
    ["running", { status: "running" }],
    ["passed", { status: "passed" }],
    ["all", {}],
  ];
  it.each(cases)("%s", (status, expected) => {
    expect(toBuildsListFilter(clean({ status }))).toEqual(expected);
  });

  it("passes the branch through, and nothing else", () => {
    expect(
      toBuildsListFilter(
        clean({
          branch: "main",
          q: "x",
          facets: { browser: "chrome" },
          props: { a: "b" },
        }),
      ),
    ).toEqual({ needsReview: true, branch: "main" });
  });
});

describe("batchHref", () => {
  it("is the bare batch route for a clean context", () => {
    expect(batchHref("p1", "b1")).toBe("/projects/p1/builds/b1");
    expect(batchHref("p1", "b1", clean())).toBe("/projects/p1/builds/b1");
  });

  it("carries the status and the environment facets", () => {
    expect(
      batchHref(
        "p1",
        "b1",
        clean({ status: "all", facets: { browser: "chrome" } }),
      ),
    ).toBe("/projects/p1/builds/b1?status=all&browser=chrome");
  });

  it("does not carry the Batches-only params (branch, search, props)", () => {
    expect(
      batchHref(
        "p1",
        "b1",
        clean({ branch: "main", q: "x", props: { a: "b" } }),
      ),
    ).toBe("/projects/p1/builds/b1");
  });

  it("anchors on a run, after the query", () => {
    expect(batchHref("p1", "b1", undefined, "r1")).toBe(
      "/projects/p1/builds/b1#run-r1",
    );
    expect(batchHref("p1", "b1", clean({ status: "failed" }), "r1")).toBe(
      "/projects/p1/builds/b1?status=failed#run-r1",
    );
  });
});

describe("useReviewContext", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    currentParams = new URLSearchParams();
    currentPath = "/inbox";
  });
  afterEach(() => cleanup());

  it("reads the context from the URL", () => {
    currentParams = new URLSearchParams("status=failed&branch=main");
    const { result } = renderHook(() => useReviewContext());
    expect(result.current[0]).toEqual(
      clean({ status: "failed", branch: "main" }),
    );
  });

  it("keeps the same context object while the URL is unchanged", () => {
    const { result, rerender } = renderHook(() => useReviewContext());
    const first = result.current[0];
    rerender();
    expect(result.current[0]).toBe(first);
  });

  it("writes a patch through router.replace without scrolling", () => {
    const { result } = renderHook(() => useReviewContext());
    act(() => result.current[1]({ status: "failed" }));
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith("/inbox?status=failed", {
      scroll: false,
    });
  });

  it("goes back to the bare path when the patch restores the defaults", () => {
    currentParams = new URLSearchParams("status=failed");
    const { result } = renderHook(() => useReviewContext());
    act(() => result.current[1]({ status: "needs-review" }));
    expect(replaceMock).toHaveBeenCalledWith("/inbox", { scroll: false });
  });

  it("merges a patch into the current context and clears a key set to undefined", () => {
    currentParams = new URLSearchParams("status=all&branch=main&q=abc");
    const { result } = renderHook(() => useReviewContext());
    act(() => result.current[1]({ branch: undefined, q: "new" }));
    expect(replaceMock).toHaveBeenCalledWith("/inbox?status=all&q=new", {
      scroll: false,
    });
  });

  it("replaces the facets as a whole", () => {
    currentParams = new URLSearchParams("browser=chrome&os=macOS");
    const { result } = renderHook(() => useReviewContext());
    act(() => result.current[1]({ facets: { browser: "firefox" } }));
    expect(replaceMock).toHaveBeenCalledWith("/inbox?browser=firefox", {
      scroll: false,
    });
  });

  it("leaves params that are not review context alone", () => {
    currentParams = new URLSearchParams("expand=b1&status=failed");
    const { result } = renderHook(() => useReviewContext());
    act(() => result.current[1]({ status: "passed" }));
    expect(replaceMock).toHaveBeenCalledWith("/inbox?expand=b1&status=passed", {
      scroll: false,
    });
  });

  it("composes two patches issued before the URL has re-rendered", () => {
    const { result } = renderHook(() => useReviewContext());
    act(() => {
      result.current[1]({ status: "failed" });
      result.current[1]({ branch: "main" });
    });
    expect(replaceMock).toHaveBeenLastCalledWith(
      "/inbox?status=failed&branch=main",
      { scroll: false },
    );
  });

  it("round-trips props through the URL", () => {
    const { result } = renderHook(() => useReviewContext());
    act(() => result.current[1]({ props: { team: "web", env: "a b" } }));
    const url = replaceMock.mock.calls[0]![0] as string;
    currentParams = new URLSearchParams(url.split("?")[1]);
    const again = renderHook(() => useReviewContext());
    expect(again.result.current[0].props).toEqual({ team: "web", env: "a b" });
  });
});
