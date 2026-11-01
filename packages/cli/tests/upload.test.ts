import type { ResultStatus, TestResult } from "@furan/client";
import { describe, expect, it, vi } from "vitest";

import type { PlannedTest } from "../src/scan.js";
import { exitCodeFor, overallStatus, runUpload } from "../src/upload.js";

import { fakeFuran, uploadArgs } from "./fake-furan.js";
import { TINY_PNG } from "./helpers.js";

const plan = (...tests: Array<[string, string[]]>): PlannedTest[] =>
  tests.map(([name, steps]) => ({
    name,
    steps: steps.map((s) => ({
      name: s,
      file: `/shots/${s}.png`,
      sidecar: null,
      width: 1,
      height: 1,
    })),
  }));

const deps = (f: ReturnType<typeof fakeFuran>, signal?: AbortSignal) => ({
  furan: f.furan,
  readFile: vi.fn(async (_path: string) => TINY_PNG),
  log: vi.fn(),
  ...(signal ? { signal } : {}),
});

describe("runUpload", () => {
  it("uploads every step, completes each test after its last step, then waits", async () => {
    const f = fakeFuran();
    const report = await runUpload(
      plan(["a", ["a/1", "a/2"]], ["b", ["b/1"]]),
      uploadArgs(),
      deps(f),
    );
    for (const name of ["a", "b"]) {
      const own = f.events.filter((e) => e.startsWith(`${name}:`));
      const lastCheck = own.findLastIndex((e) => e.includes(":check:"));
      expect(own.indexOf(`${name}:complete`)).toBeGreaterThan(lastCheck);
      expect(own.indexOf(`${name}:result`)).toBeGreaterThan(
        own.indexOf(`${name}:complete`),
      );
    }
    expect(f.test("a").check).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({
      buildId: "b1",
      buildUrl: "https://d/projects/p/builds/b1",
      branch: "main",
      exitCode: 0,
    });
    expect(report.tests.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("merges --ignore with sidecar regions; sidecar matchLevel wins", async () => {
    const f = fakeFuran();
    const p = plan(["a", ["a/1"]]);
    const box = (x: number) => ({ x, y: 0, width: 1, height: 1 });
    p[0]!.steps[0]!.sidecar = {
      matchLevel: "Content",
      ignore: [box(2)],
      layout: [box(3)],
    };
    await runUpload(
      p,
      uploadArgs({ ignore: [box(1)], matchLevel: "Layout" }),
      deps(f),
    );
    expect(f.test("a").check.mock.calls[0]![2]).toMatchObject({
      ignore: [box(1), box(2)],
      layout: [box(3)],
      matchLevel: "Content",
    });
  });

  it("--viewport, --browser, --os and --device apply to every step", async () => {
    const f = fakeFuran();
    await runUpload(
      plan(["a", ["a/1", "a/2"]]),
      uploadArgs({
        viewport: "800x600",
        browser: "chrome",
        os: "Linux",
        device: "Pixel 8",
      }),
      deps(f),
    );
    for (const call of f.test("a").check.mock.calls) {
      expect(call[2]).toMatchObject({
        viewport: "800x600",
        browser: "chrome",
        os: "Linux",
        device: "Pixel 8",
      });
    }
  });

  it("bounded concurrency", async () => {
    const f = fakeFuran();
    const steps = Array.from({ length: 10 }, (_, i) => `a/${i}`);
    await runUpload(
      plan(["a", steps]),
      uploadArgs({ concurrency: 2 }),
      deps(f),
    );
    expect(f.test("a").check).toHaveBeenCalledTimes(10);
    expect(f.stats.maxInFlight).toBeLessThanOrEqual(2);
  });

  it("an upload error aborts every open test and rethrows", async () => {
    const f = fakeFuran();
    const d = deps(f);
    d.readFile.mockImplementation(async (path: string) => {
      if (path.includes("b/1")) throw new Error("disk gone");
      return TINY_PNG;
    });
    await expect(
      runUpload(plan(["a", ["a/1"]], ["b", ["b/1"]]), uploadArgs(), d),
    ).rejects.toThrow("disk gone");
    expect(f.test("a").abort).toHaveBeenCalled();
    expect(f.test("b").abort).toHaveBeenCalled();
    expect(f.test("a").result).not.toHaveBeenCalled();
  });

  it("abort signal mid-upload aborts open tests", async () => {
    const f = fakeFuran();
    const controller = new AbortController();
    const d = deps(f, controller.signal);
    // Ctrl-C while the first step is being read.
    d.readFile.mockImplementation(async () => {
      controller.abort(new Error("interrupted"));
      return TINY_PNG;
    });
    await expect(
      runUpload(plan(["a", ["a/1", "a/2"]]), uploadArgs({ concurrency: 1 }), d),
    ).rejects.toThrow("interrupted");
    expect(f.test("a").abort).toHaveBeenCalled();
    expect(f.test("a").complete).not.toHaveBeenCalled();
  });

  it("an abort before anything opened opens nothing", async () => {
    const f = fakeFuran();
    const controller = new AbortController();
    controller.abort(new Error("interrupted"));
    await expect(
      runUpload(plan(["a", ["a/1"]]), uploadArgs(), deps(f, controller.signal)),
    ).rejects.toThrow("interrupted");
    expect(f.build.openTest).not.toHaveBeenCalled();
  });

  it("--no-wait reports uploaded and never calls result", async () => {
    const f = fakeFuran();
    const report = await runUpload(
      plan(["a", ["a/1"]]),
      uploadArgs({ wait: false }),
      deps(f),
    );
    expect(f.test("a").result).not.toHaveBeenCalled();
    expect(report.tests[0]!.status).toBe("uploaded");
    expect(report.exitCode).toBe(0);
  });

  it("waits for every test under one deadline", async () => {
    const f = fakeFuran();
    const before = Date.now();
    await runUpload(
      plan(["a", ["a/1"]], ["b", ["b/1"]]),
      uploadArgs(),
      deps(f),
    );
    const deadlines = [f.test("a"), f.test("b")].map(
      (t) => (t.result.mock.calls[0]![0] as { deadline: number }).deadline,
    );
    expect(deadlines[0]).toBe(deadlines[1]);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + 120_000);
  });

  it("a failed test gives exit code 1", async () => {
    const f = fakeFuran({
      b: { status: "failed", serverStatus: "unresolved" },
    });
    const report = await runUpload(
      plan(["a", ["a/1"]], ["b", ["b/1"]]),
      uploadArgs(),
      deps(f),
    );
    expect(report.exitCode).toBe(1);
  });
});

const results = (...statuses: ResultStatus[]): TestResult[] =>
  statuses.map((status, i) => ({
    name: `t${i}`,
    runId: `r${i}`,
    status,
    serverStatus: null,
    steps: [],
    url: null,
  }));

describe("exitCodeFor", () => {
  it.each<[ResultStatus[], boolean, number]>([
    [["passed", "passed"], false, 0],
    [["passed", "new"], false, 0],
    [["new"], true, 1],
    [["failed", "error"], false, 1],
    [["passed", "error"], false, 3],
    [["uploaded"], false, 0],
  ])("%j (failOnNew %s) → %i", (statuses, failOnNew, code) => {
    expect(exitCodeFor(results(...statuses), failOnNew)).toBe(code);
  });
});

describe("overallStatus", () => {
  it.each<[ResultStatus[], boolean, string]>([
    [["passed", "failed", "error"], false, "failed"],
    [["passed", "error"], false, "error"],
    [["passed", "new"], false, "new"],
    [["new"], true, "failed"],
    [["uploaded", "uploaded"], false, "uploaded"],
    [["passed", "passed"], false, "passed"],
  ])("%j (failOnNew %s) → %s", (statuses, failOnNew, status) => {
    expect(overallStatus(results(...statuses), failOnNew)).toBe(status);
  });
});
