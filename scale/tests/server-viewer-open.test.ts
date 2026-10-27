import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcResult } from "../src/clients/http.js";
import type { Seeded } from "../src/seed/index.js";
import type { Stack } from "../src/stack/api.js";
import type { ViewerCall } from "../src/suites/viewer-calls.js";

/**
 * The server suite's R4 probe (`measureViewerOpen`) and how it picks each
 * step's neighbours (`withNeighbours`), without an api or a database: the
 * tRPC client and the rail read are fakes.
 */

/** What the fake tRPC client was asked, in order, and how it answers. */
const fake = vi.hoisted(() => ({
  queries: [] as Array<{ path: string; input: unknown }>,
  answer: (_path: string, _input: unknown, _n: number): TrpcResult => ({
    ms: 1,
    bytes: 0,
    status: 200,
    data: null,
  }),
  rails: new Map<string, string[]>(),
}));

vi.mock("../src/clients/http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/clients/http.js")>()),
  trpc: () => ({
    query: (path: string, input?: unknown) => {
      fake.queries.push({ path, input });
      return Promise.resolve(fake.answer(path, input, fake.queries.length));
    },
    mutation: () => Promise.reject(new Error("the probe only queries")),
  }),
}));

vi.mock("../src/seed/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/seed/index.js")>()),
  railsOf: vi.fn(() => Promise.resolve(fake.rails)),
}));

const { railsOf } = await import("../src/seed/index.js");
const { PROBE_CALLS, PROBE_WARMUP, measureViewerOpen, withNeighbours } =
  await import("../src/suites/server.js");

type Recorder = Parameters<typeof measureViewerOpen>[4];

const stack = { apiUrl: "http://api.test", db: {} } as unknown as Stack;
const seeded = {} as Seeded;
const PASSES = PROBE_WARMUP + PROBE_CALLS;

function recorder(): Recorder {
  return {
    samples: [],
    statuses: [],
    measuring: true,
    openedAt: 0,
    stopped: false,
    alive: () => {},
  };
}

/** A call of the viewer set with fixed inputs. */
const call = (path: string, inputs: unknown[]): ViewerCall => ({
  path,
  inputs: () => inputs,
  inputsAt: () => inputs,
});

/** The step and the two neighbours the viewer fetches ahead. */
const STEP_INPUTS = ["c2", "c3", "c1"].map((checkpointId) => ({
  runId: "r1",
  checkpointId,
}));
const CALLS = [
  call("runs.getStep", STEP_INPUTS),
  call("runs.getById", [{ runId: "r1" }]),
];

/** Each step read: its bytes and time, by step. */
const STEP_ANSWER: Record<string, { bytes: number; ms: number }> = {
  c2: { bytes: 1024, ms: 3 },
  c3: { bytes: 2048, ms: 4 },
  c1: { bytes: 512, ms: 5 },
};

function answerSteps(path: string, input: unknown): TrpcResult {
  if (path === "runs.getStep") {
    const { checkpointId } = input as { checkpointId: string };
    return { ...STEP_ANSWER[checkpointId]!, status: 200, data: null };
  }
  return { bytes: 1024, ms: 1, status: 200, data: null };
}

beforeEach(() => {
  fake.queries.length = 0;
  fake.answer = answerSteps;
  fake.rails = new Map();
  vi.mocked(railsOf).mockClear();
});

describe("measureViewerOpen (R4)", () => {
  it("sends every request of a path on every pass, and times each one", async () => {
    const rec = recorder();
    const [time] = await measureViewerOpen(
      stack,
      seeded,
      CALLS,
      "token",
      rec,
      "fallback",
    );

    // Each pass sends the three step reads and the header, warm-ups included.
    expect(fake.queries).toHaveLength(PASSES * 4);
    const stepInputs = fake.queries
      .filter((q) => q.path === "runs.getStep")
      .map((q) => (q.input as { checkpointId: string }).checkpointId);
    for (const id of ["c2", "c3", "c1"]) {
      expect(stepInputs.filter((x) => x === id)).toHaveLength(PASSES);
    }
    expect(rec.statuses).toHaveLength(PASSES * 4);

    // R4.time: the slowest path's p95, a path's requests pooled. getStep's
    // 3 × 50 measured requests (3, 4 and 5 ms) give 5 ms; getById's 1 ms.
    expect(time).toMatchObject({ id: "R4.time", value: 5, samples: 50 });
    expect(time!.note).toContain("2 procedures in 4 requests");
    expect(time!.note).toContain("runs.getStep 5.0 ms");
    expect(time!.note).toContain("runs.getById 1.0 ms");
  });

  it("R4.size adds up every request of a path in a pass", async () => {
    const [, size] = await measureViewerOpen(
      stack,
      seeded,
      CALLS,
      "token",
      recorder(),
      "fallback",
    );
    // (1024 + 2048 + 512) bytes of steps and 1024 of header: 4.5 KB.
    expect(size).toMatchObject({ id: "R4.size", value: 4.5, samples: 1 });
    expect(size!.note).toContain("runs.getStep 3.5 KB");
    expect(size!.note).toContain("runs.getById 1.0 KB");
  });

  it("R4.size is the largest pass that fully succeeded", async () => {
    // The last pass's header fails, with a body larger than any other pass:
    // it is not the one R4.size reports, and R4.time says a call failed.
    fake.answer = (path, input, n) =>
      n === PASSES * 4
        ? { bytes: 1024 * 1024, ms: 1, status: 500, data: null }
        : answerSteps(path, input);
    const [time, size] = await measureViewerOpen(
      stack,
      seeded,
      CALLS,
      "token",
      recorder(),
      "fallback",
    );
    expect(size).toMatchObject({ id: "R4.size", value: 4.5 });
    expect(time!.note).toContain("1 calls failed (see R8)");
    // getById has 49 successful measured calls left, the fewest of any path.
    expect(time).toMatchObject({ value: 5, samples: PROBE_CALLS - 1 });
  });

  it("refuses an empty call set", async () => {
    await expect(
      measureViewerOpen(stack, seeded, [], "token", recorder(), "fallback"),
    ).rejects.toThrow("the viewer call set is empty");
  });
});

describe("withNeighbours", () => {
  it("gives each step the steps either side of it in its run's rail, next first", async () => {
    fake.rails = new Map([
      ["r1", ["c1", "c2", "c3"]],
      ["r2", ["d1"]],
    ]);
    const targets = await withNeighbours(stack, "p1", [
      { buildId: "b1", runId: "r1", checkpointId: "c2" },
      { buildId: "b1", runId: "r1", checkpointId: "c1" },
      { buildId: "b2", runId: "r2", checkpointId: "d1" },
      // A run with no rail (no steps read): no neighbours.
      { buildId: "b3", runId: "r3", checkpointId: "x1" },
    ]);
    expect(targets).toEqual([
      {
        projectId: "p1",
        buildId: "b1",
        runId: "r1",
        checkpointId: "c2",
        neighbours: ["c3", "c1"],
      },
      {
        projectId: "p1",
        buildId: "b1",
        runId: "r1",
        checkpointId: "c1",
        neighbours: ["c2"],
      },
      {
        projectId: "p1",
        buildId: "b2",
        runId: "r2",
        checkpointId: "d1",
        neighbours: [],
      },
      {
        projectId: "p1",
        buildId: "b3",
        runId: "r3",
        checkpointId: "x1",
        neighbours: [],
      },
    ]);
    // One read of the rails, of every run asked for, in the project.
    expect(railsOf).toHaveBeenCalledTimes(1);
    expect(railsOf).toHaveBeenCalledWith(stack.db, "p1", [
      "r1",
      "r1",
      "r2",
      "r3",
    ]);
  });
});
