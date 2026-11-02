import { describe, expect, it, vi } from "vitest";

import {
  Furan,
  FuranApiError,
  FuranTimeoutError,
  resolveConfig,
  type FuranClient,
  type FuranOptions,
  type Run,
} from "../src/index.js";

import { TINY_PNG } from "./helpers.js";

const PROJECT = "3f2b6c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f";
const BUILD = "0e6b8f7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";

function config(options: FuranOptions = {}) {
  return resolveConfig(
    { branch: "feature/x", ...options },
    {
      FURAN_API_URL: "http://h/api",
      FURAN_API_TOKEN: "t",
      FURAN_PROJECT_ID: PROJECT,
    },
    { gitBranch: () => null },
  );
}

const run = (status: string, autoApproved = false): Run => ({
  id: "r1",
  projectId: PROJECT,
  buildId: "b1",
  name: "t",
  status,
  branchName: "feature/x",
  checkpointCount: 1,
  autoApproved,
});

function fakeClient(settled: Run | Error = run("passed")) {
  return {
    createBuild: vi.fn(async () => ({
      id: "b1",
      projectId: PROJECT,
      ciBuildId: null,
      branchName: null,
      name: null,
      number: null,
    })),
    createRun: vi.fn(async () => ({
      runId: "r1",
      status: "running",
      name: "t",
    })),
    uploadCheckpoint: vi.fn(async (_runId: string, _input: unknown) => ({
      checkpointId: "c1",
      testVariationId: "v1",
    })),
    completeRun: vi.fn(async () => ({
      runId: "r1",
      status: "running",
      checkpointCount: 1,
    })),
    waitForRun: vi.fn(async (_runId: string, _opts: unknown) => {
      if (settled instanceof Error) throw settled;
      return settled;
    }),
    approveRun: vi.fn(async () => {}),
    abortRun: vi.fn(async () => {}),
  };
}

function furan(options: FuranOptions = {}, settled?: Run | Error) {
  const client = fakeClient(settled);
  return {
    f: new Furan(config(options), client as unknown as FuranClient),
    client,
  };
}

describe("Furan lifecycle", () => {
  it("openBuild is single-flight", async () => {
    const { f, client } = furan();
    const [a, b] = await Promise.all([f.openBuild(), f.openBuild()]);
    expect(a).toBe(b);
    expect(client.createBuild).toHaveBeenCalledTimes(1);
  });

  it("openBuild sends ciBuildId, branch, name, number and properties from config", async () => {
    const { f, client } = furan({
      ciBuildId: "ci-1",
      buildName: "CI #7",
      buildNumber: 7,
      properties: { shard: "1" },
    });
    await f.openBuild();
    expect(client.createBuild).toHaveBeenCalledWith({
      ciBuildId: "ci-1",
      branch: "feature/x",
      name: "CI #7",
      number: 7,
      properties: { shard: "1" },
    });
  });

  it("config.buildId skips createBuild", async () => {
    const { f, client } = furan({ buildId: BUILD });
    const build = await f.openBuild();
    expect(build.id).toBe(BUILD);
    expect(client.createBuild).not.toHaveBeenCalled();
  });

  it("a failed openBuild can be retried", async () => {
    const { f, client } = furan();
    client.createBuild.mockRejectedValueOnce(new Error("down"));
    await expect(f.openBuild()).rejects.toThrow("down");
    await expect(f.openBuild()).resolves.toMatchObject({ id: "b1" });
  });

  it("openTest creates a run with branch and parentBranch", async () => {
    const { f, client } = furan({ parentBranch: "main" });
    const test = await (await f.openBuild()).openTest("checkout");
    expect(test.runId).toBe("r1");
    expect(client.createRun).toHaveBeenCalledWith({
      buildId: "b1",
      name: "checkout",
      branch: "feature/x",
      parentBranch: "main",
    });
  });

  it("check uses config browser/os/device and remembers the step", async () => {
    const { f, client } = furan({
      browser: "chrome",
      os: "Linux",
      device: "Pixel 8",
    });
    const test = await (await f.openBuild()).openTest("checkout");
    const box = { x: 1, y: 2, width: 3, height: 4 };
    await test.check("checkout/cart", TINY_PNG, {
      ignore: [box],
      matchLevel: "Layout",
    });
    expect(client.uploadCheckpoint).toHaveBeenCalledWith("r1", {
      name: "checkout/cart",
      png: TINY_PNG,
      browser: "chrome",
      os: "Linux",
      device: "Pixel 8",
      matchLevel: "Layout",
      regions: { ignore: [box], layout: [], content: [], floating: [] },
    });
    expect(test.steps).toEqual(["checkout/cart"]);
  });

  it("check options override the config's environment labels", async () => {
    const { f, client } = furan({ browser: "chrome" });
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG, {
      browser: "firefox",
      viewport: "800x600",
    });
    expect(client.uploadCheckpoint.mock.calls[0]![1]).toMatchObject({
      browser: "firefox",
      viewport: "800x600",
    });
  });

  it("complete on a test with no checks aborts and result is skipped", async () => {
    const { f, client } = furan();
    const test = await (await f.openBuild()).openTest("t");
    await test.complete();
    expect(client.abortRun).toHaveBeenCalledWith("r1");
    expect(client.completeRun).not.toHaveBeenCalled();
    expect((await test.result()).status).toBe("skipped");
  });

  it("result maps unresolved to failed with the run url", async () => {
    const { f } = furan({ dashboardUrl: "https://d" }, run("unresolved"));
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    const r = await test.close();
    expect(r).toEqual({
      name: "t",
      runId: "r1",
      status: "failed",
      serverStatus: "unresolved",
      steps: ["s"],
      url: `https://d/projects/${PROJECT}/runs/r1`,
    });
    expect(f.buildUrl("b1")).toBe(`https://d/projects/${PROJECT}/builds/b1`);
  });

  it("result completes a test that was not completed yet", async () => {
    const { f, client } = furan();
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    await test.result();
    expect(client.completeRun).toHaveBeenCalledTimes(1);
  });

  it("result waits under the deadline with the poll interval", async () => {
    const { f, client } = furan({ pollIntervalMs: 500 });
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    await test.result({ deadline: Date.now() + 10_000 });
    const opts = client.waitForRun.mock.calls[0]![1] as {
      timeoutMs: number;
      intervalMs: number;
    };
    expect(opts.intervalMs).toBe(500);
    expect(opts.timeoutMs).toBeGreaterThan(9_000);
    expect(opts.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("new without a baseline is reported new, with no url when there is no dashboard", async () => {
    const { f, client } = furan({}, run("new"));
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    const r = await test.close();
    expect(r).toMatchObject({ status: "new", serverStatus: "new", url: null });
    expect(client.approveRun).not.toHaveBeenCalled();
  });

  it("saveNewTests approves a new run and reports passed", async () => {
    const { f, client } = furan({ saveNewTests: true }, run("new"));
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    const r = await test.close();
    expect(client.approveRun).toHaveBeenCalledWith("r1");
    expect(r).toMatchObject({ status: "passed", serverStatus: "new" });
  });

  it("approve 409 reports error, not passed", async () => {
    const { f, client } = furan({ saveNewTests: true }, run("new"));
    client.approveRun.mockRejectedValueOnce(
      new FuranApiError({
        status: 409,
        code: "approve_failed",
        message: "Approve failed",
        method: "POST",
        path: "runs/r1/approve",
        requestId: "x",
      }),
    );
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    const r = await test.close();
    expect(r.status).toBe("error");
    expect(r.error).toBeInstanceOf(FuranApiError);
  });

  it("timeout reports error with FuranTimeoutError", async () => {
    const { f } = furan({}, new FuranTimeoutError("r1", "running", 1000));
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    const r = await test.close();
    expect(r.status).toBe("error");
    expect(r.error).toBeInstanceOf(FuranTimeoutError);
    expect(r.serverStatus).toBeNull();
  });

  it("an aborted signal is rethrown, not reported", async () => {
    const reason = new Error("interrupted");
    const { f } = furan({}, reason);
    const controller = new AbortController();
    controller.abort(reason);
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    await expect(test.result({ signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it("close({ wait: false }) reports uploaded and never polls", async () => {
    const { f, client } = furan();
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    const r = await test.close({ wait: false });
    expect(r.status).toBe("uploaded");
    expect(client.completeRun).toHaveBeenCalledTimes(1);
    expect(client.waitForRun).not.toHaveBeenCalled();
  });

  it("abort aborts an open test once, and never a completed one", async () => {
    const { f, client } = furan();
    const test = await (await f.openBuild()).openTest("t");
    await test.check("s", TINY_PNG);
    await test.abort();
    await test.abort();
    expect(client.abortRun).toHaveBeenCalledTimes(1);

    const done = await (await f.openBuild()).openTest("t2");
    await done.check("s", TINY_PNG);
    await done.complete();
    await done.abort();
    expect(client.abortRun).toHaveBeenCalledTimes(1);
  });
});
