import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FuranClient,
  FuranInputError,
  FuranTimeoutError,
} from "../src/index.js";

import { TINY_PNG } from "./helpers.js";

const PROJECT = "3f2b6c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f";

function setup(...replies: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const r = replies.shift() ?? { body: {} };
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const sleep = vi.fn(async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  });
  const client = new FuranClient(
    { apiUrl: "http://h/api", token: "t", projectId: PROJECT },
    { fetch: fetchFn as unknown as typeof fetch, sleep, random: () => 1 },
  );
  return { client, calls, sleep };
}

const sentJson = (init: RequestInit) =>
  JSON.parse(String(init.body)) as unknown;
const sentForm = (init: RequestInit) => init.body as FormData;

afterEach(() => {
  vi.useRealTimers();
});

describe("FuranClient", () => {
  it("createBuild posts to projects/:id/builds and omits unset fields", async () => {
    const { client, calls } = setup({
      status: 201,
      body: { id: "b1", projectId: PROJECT, ciBuildId: "ci-1" },
    });
    const build = await client.createBuild({
      ciBuildId: "ci-1",
      branch: "main",
    });
    expect(calls[0]!.url).toBe(`http://h/api/projects/${PROJECT}/builds`);
    expect(sentJson(calls[0]!.init)).toEqual({
      ciBuildId: "ci-1",
      branchName: "main",
    });
    expect(build).toEqual({
      id: "b1",
      projectId: PROJECT,
      ciBuildId: "ci-1",
      branchName: null,
      name: null,
      number: null,
    });
  });

  it("createBuild sends name, number and non-empty properties", async () => {
    const { client, calls } = setup({ status: 201, body: { id: "b1" } });
    await client.createBuild({
      name: "CI #7",
      number: 7,
      properties: { shard: "1" },
    });
    expect(sentJson(calls[0]!.init)).toEqual({
      name: "CI #7",
      number: 7,
      properties: { shard: "1" },
    });
    await client.createBuild({ properties: {} });
    expect(sentJson(calls[1]!.init)).toEqual({});
  });

  it("createRun sends the run body and parentBranchName only when set", async () => {
    const { client, calls } = setup(
      { status: 201, body: { runId: "r1", status: "running", name: "t" } },
      { status: 201, body: { runId: "r2", status: "running", name: "t" } },
    );
    await client.createRun({ buildId: "b1", name: "t", branch: "main" });
    expect(sentJson(calls[0]!.init)).toEqual({
      projectId: PROJECT,
      buildId: "b1",
      name: "t",
      branchName: "main",
    });
    const r = await client.createRun({
      buildId: "b1",
      name: "t",
      branch: "feature/x",
      parentBranch: "main",
    });
    expect(sentJson(calls[1]!.init)).toMatchObject({
      parentBranchName: "main",
    });
    expect(r).toEqual({ runId: "r2", status: "running", name: "t" });
  });

  it("uploadCheckpoint builds the multipart body", async () => {
    const { client, calls } = setup({
      body: { screenshotId: "s1", checkpointId: "s1", testVariationId: "v1" },
    });
    const ref = await client.uploadCheckpoint("r1", {
      name: "home",
      png: TINY_PNG,
      os: null,
      regions: { ignore: [{ x: 1, y: 2, width: 3, height: 4 }] },
    });
    expect(calls[0]!.url).toBe("http://h/api/runs/r1/screenshots");
    const form = sentForm(calls[0]!.init);
    expect(form).toBeInstanceOf(FormData);
    const png = form.get("pngBytes") as File;
    expect(png.type).toBe("image/png");
    expect(png.name).toBe("snap.png");
    expect(form.get("name")).toBe("home");
    expect(form.get("viewport")).toBe("1x1");
    expect(form.get("browser")).toBe("image");
    expect(form.get("matchLevel")).toBe("Strict");
    expect(JSON.parse(String(form.get("regions")))).toEqual({
      ignore: [{ x: 1, y: 2, width: 3, height: 4 }],
      layout: [],
      floating: [],
      content: [],
      accessibility: [],
    });
    expect(form.has("os")).toBe(false);
    expect(form.has("device")).toBe(false);
    expect(form.has("ignoreDisplacements")).toBe(false);
    expect(ref).toEqual({ checkpointId: "s1", testVariationId: "v1" });
  });

  it("uploadCheckpoint sends the overrides it is given", async () => {
    const { client, calls } = setup({
      body: { checkpointId: "s1", testVariationId: "v1" },
    });
    await client.uploadCheckpoint("r1", {
      name: "home",
      png: TINY_PNG,
      viewport: "1280x720",
      browser: "playwright-chromium",
      os: "Linux",
      device: "Pixel 8",
      matchLevel: "Layout",
      ignoreDisplacements: true,
    });
    const form = sentForm(calls[0]!.init);
    expect(form.get("viewport")).toBe("1280x720");
    expect(form.get("browser")).toBe("playwright-chromium");
    expect(form.get("os")).toBe("Linux");
    expect(form.get("device")).toBe("Pixel 8");
    expect(form.get("matchLevel")).toBe("Layout");
    expect(form.get("ignoreDisplacements")).toBe("true");
  });

  it("regions JSON matches the Kotlin wire for the same boxes", async () => {
    const { client, calls } = setup({
      body: { checkpointId: "s1", testVariationId: "v1" },
    });
    await client.uploadCheckpoint("r1", {
      name: "home",
      png: TINY_PNG,
      // Extra keys (as a caller might pass) are not sent.
      regions: {
        ignore: [{ height: 4, width: 3, y: 2, x: 1, extra: true } as never],
      },
    });
    expect(sentForm(calls[0]!.init).get("regions")).toBe(
      '{"ignore":[{"x":1,"y":2,"width":3,"height":4}],"layout":[],"floating":[],"content":[],"accessibility":[]}',
    );
  });

  it("51 ignore boxes → FuranInputError, nothing sent", async () => {
    const { client, calls } = setup();
    const box = { x: 0, y: 0, width: 1, height: 1 };
    await expect(
      client.uploadCheckpoint("r1", {
        name: "home",
        png: TINY_PNG,
        regions: { ignore: Array.from({ length: 51 }, () => box) },
      }),
    ).rejects.toBeInstanceOf(FuranInputError);
    expect(calls).toHaveLength(0);
  });

  it("a non-PNG → FuranInputError, nothing sent", async () => {
    const { client, calls } = setup();
    await expect(
      client.uploadCheckpoint("r1", {
        name: "home",
        png: new Uint8Array(Buffer.from("not a png at all, really not")),
      }),
    ).rejects.toBeInstanceOf(FuranInputError);
    expect(calls).toHaveLength(0);
  });

  it("getRun maps the run row and defaults autoApproved", async () => {
    const { client } = setup({
      body: {
        id: "r1",
        projectId: PROJECT,
        buildId: "b1",
        name: "t",
        status: "passed",
        branchName: "main",
        checkpointCount: 2,
        diffPercent: 0,
      },
    });
    expect(await client.getRun("r1")).toEqual({
      id: "r1",
      projectId: PROJECT,
      buildId: "b1",
      name: "t",
      status: "passed",
      branchName: "main",
      checkpointCount: 2,
      autoApproved: false,
    });
  });

  it("waitForRun polls while running and returns the settled run", async () => {
    vi.useFakeTimers();
    const run = (status: string) => ({
      body: { id: "r1", projectId: PROJECT, buildId: "b1", name: "t", status },
    });
    const { client, calls, sleep } = setup(
      run("running"),
      run("running"),
      run("passed"),
    );
    const settled = await client.waitForRun("r1", { intervalMs: 2000 });
    expect(settled.status).toBe("passed");
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("waitForRun throws FuranTimeoutError with the last status", async () => {
    vi.useFakeTimers();
    const running = {
      body: {
        id: "r1",
        projectId: PROJECT,
        buildId: "b1",
        name: "t",
        status: "running",
      },
    };
    const { client } = setup(...Array.from({ length: 20 }, () => running));
    const err = await client
      .waitForRun("r1", { timeoutMs: 5000, intervalMs: 2000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FuranTimeoutError);
    expect((err as FuranTimeoutError).lastStatus).toBe("running");
  });

  it("completeRun, approveRun and abortRun post to their routes", async () => {
    const { client, calls } = setup(
      { body: { runId: "r1", status: "running", checkpointCount: 1 } },
      { body: { runId: "r1", approved: true } },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    );
    expect(await client.completeRun("r1")).toEqual({
      runId: "r1",
      status: "running",
      checkpointCount: 1,
    });
    await client.approveRun("r1");
    await expect(client.abortRun("r1")).resolves.toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([
      "http://h/api/runs/r1/complete",
      "http://h/api/runs/r1/approve",
      "http://h/api/runs/r1/abort",
      "http://h/api/runs/r1/abort",
      "http://h/api/runs/r1/abort",
      "http://h/api/runs/r1/abort",
    ]);
  });
});
