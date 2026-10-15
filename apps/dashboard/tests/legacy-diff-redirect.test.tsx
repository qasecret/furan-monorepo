import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// redirect() throws in real Next to abort rendering; emulate that with a
// sentinel so we can both assert the target and stop execution like prod does.
class RedirectError extends Error {
  constructor(public to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}
const redirectMock = vi.fn((to: string) => {
  throw new RedirectError(to);
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirectMock(to),
}));

vi.mock("@/lib/api-client", () => ({ apiGet: vi.fn() }));

import LegacyDiffPage from "@/app/(protected)/projects/[projectId]/runs/[runId]/diffs/[diffId]/page";
import { apiGet } from "@/lib/api-client";

const RUN = "11111111-1111-4111-8111-111111111111";
const STEP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STEP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The tRPC query as the API answers it: no transformer, `{ result: { data } }`. */
function stepsOfRun(ids: string[]) {
  return {
    status: 200,
    data: { result: { data: { items: ids.map((id) => ({ id })) } } },
  };
}

function renderPage(
  diffId: string,
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  return LegacyDiffPage({
    params: Promise.resolve({ projectId: "p1", runId: RUN, diffId }),
    searchParams: Promise.resolve(searchParams),
  });
}

async function redirectedTo(page: Promise<unknown>): Promise<string> {
  try {
    await page;
  } catch (e) {
    if (e instanceof RedirectError) return e.to;
    throw e;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
});

afterEach(() => {
  redirectMock.mockClear();
});

describe("legacy /runs/:runId/diffs/:diffId redirect", () => {
  test("goes to the checkpoint when it belongs to the run", async () => {
    vi.mocked(apiGet).mockResolvedValue(stepsOfRun([STEP_A, STEP_B]));
    expect(await redirectedTo(renderPage(STEP_B))).toBe(
      `/projects/p1/runs/${RUN}/checkpoints/${STEP_B}`,
    );
  });

  test("looks the run's steps up with the tRPC query over the server API helper", async () => {
    vi.mocked(apiGet).mockResolvedValue(stepsOfRun([STEP_A]));
    await redirectedTo(renderPage(STEP_A));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toBe(
      `/trpc/runs.listCheckpoints?input=${encodeURIComponent(JSON.stringify({ runId: RUN }))}`,
    );
  });

  test("goes to _first when the id is not a step of the run (the old run-id link)", async () => {
    vi.mocked(apiGet).mockResolvedValue(stepsOfRun([STEP_A, STEP_B]));
    // Old history links put the RUN id where the step id belongs.
    expect(await redirectedTo(renderPage(RUN))).toBe(
      `/projects/p1/runs/${RUN}/checkpoints/_first`,
    );
  });

  test("goes to _first when the run has no steps", async () => {
    vi.mocked(apiGet).mockResolvedValue(stepsOfRun([]));
    expect(await redirectedTo(renderPage(STEP_A))).toBe(
      `/projects/p1/runs/${RUN}/checkpoints/_first`,
    );
  });

  test.each([401, 403, 404, 500])(
    "goes to _first when the lookup answers %i",
    async (status) => {
      vi.mocked(apiGet).mockResolvedValue({ status, data: null });
      expect(await redirectedTo(renderPage(STEP_A))).toBe(
        `/projects/p1/runs/${RUN}/checkpoints/_first`,
      );
    },
  );

  test("goes to _first, and does not throw, when the lookup fails", async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await redirectedTo(renderPage(STEP_A))).toBe(
      `/projects/p1/runs/${RUN}/checkpoints/_first`,
    );
  });

  test.each([
    ["a body of the wrong shape", { unexpected: true }],
    ["items that are not a list", { result: { data: { items: "nope" } } }],
    ["no data", { result: {} }],
  ])("goes to _first on %s", async (_name, data) => {
    vi.mocked(apiGet).mockResolvedValue({ status: 200, data });
    expect(await redirectedTo(renderPage(STEP_A))).toBe(
      `/projects/p1/runs/${RUN}/checkpoints/_first`,
    );
  });

  test("passes the review context through on both outcomes", async () => {
    vi.mocked(apiGet).mockResolvedValue(stepsOfRun([STEP_A]));
    const ctx = { status: "failed", browser: "chromium", viewport: "1280x720" };
    expect(await redirectedTo(renderPage(STEP_A, ctx))).toBe(
      `/projects/p1/runs/${RUN}/checkpoints/${STEP_A}?status=failed&browser=chromium&viewport=1280x720`,
    );
    expect(await redirectedTo(renderPage(RUN, ctx))).toBe(
      `/projects/p1/runs/${RUN}/checkpoints/_first?status=failed&browser=chromium&viewport=1280x720`,
    );
  });

  test("drops params that are not a review context, and bad values", async () => {
    vi.mocked(apiGet).mockResolvedValue(stepsOfRun([STEP_A]));
    expect(
      await redirectedTo(
        renderPage(STEP_A, { status: "bogus", utm_source: "mail", os: "" }),
      ),
    ).toBe(`/projects/p1/runs/${RUN}/checkpoints/${STEP_A}`);
  });

  test("encodes the ids it puts in the path", async () => {
    vi.mocked(apiGet).mockResolvedValue(stepsOfRun([]));
    const to = await redirectedTo(
      LegacyDiffPage({
        params: Promise.resolve({
          projectId: "p 1",
          runId: "r/1",
          diffId: "d",
        }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(to).toBe("/projects/p%201/runs/r%2F1/checkpoints/_first");
  });
});
