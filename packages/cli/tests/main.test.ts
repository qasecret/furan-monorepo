import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FuranApiError,
  FuranTimeoutError,
  type FuranOptions,
} from "@furan/client";
import { describe, expect, it, vi } from "vitest";

import { main } from "../src/main.js";

import { fakeFuran } from "./fake-furan.js";
import { tree } from "./helpers.js";

const TOKEN = "furan_pat_dummy1234"; // gitleaks:allow (fake test token)
const ENV = {
  FURAN_API_URL: "http://h/api",
  FURAN_API_TOKEN: TOKEN,
  FURAN_PROJECT_ID: "3f2b6c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f",
  FURAN_BRANCH: "main",
};

async function run(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    furan?: ReturnType<typeof fakeFuran>;
    signal?: AbortSignal;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const f = opts.furan ?? fakeFuran();
  const createFuran = vi.fn(
    (_o: FuranOptions, _env: NodeJS.ProcessEnv) => f.furan,
  );
  const code = await main(argv, {
    env: opts.env ?? ENV,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    createFuran,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), createFuran, f };
}

describe("main", () => {
  it("missing FURAN_API_TOKEN → 2 and names the variable", async () => {
    const dir = await tree({ "a.png": null });
    const env: Record<string, string> = { ...ENV };
    delete env.FURAN_API_TOKEN;
    const err: string[] = [];
    // No createFuran: the real factory resolves (and validates) the config.
    const code = await main(["upload", dir], {
      env,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("FURAN_API_TOKEN");
  });

  it("usage error → 2 with help hint", async () => {
    const r = await run(["upload"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("furan --help");
  });

  it("an input error → 2 and nothing created", async () => {
    const dir = await tree({ "notes.txt": "hi" });
    const r = await run(["upload", join(dir, "notes.txt")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("notes.txt");
    expect(r.createFuran).not.toHaveBeenCalled();
  });

  it("--dry-run prints masked token and the plan, creates no client", async () => {
    const dir = await tree({ "shots/home.png": null, "shots/cart.png": null });
    const r = await run(["upload", join(dir, "shots"), "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.createFuran).not.toHaveBeenCalled();
    expect(r.out).toContain("furan_pat_****1234");
    expect(r.out).not.toContain(TOKEN);
    expect(r.out).toContain("shots");
    expect(r.out).toContain("home");
    expect(r.out).toContain("cart");
  });

  it("passes flags to the config, leaving unset ones to env", async () => {
    const dir = await tree({ "a.png": null });
    const r = await run([
      "upload",
      dir,
      "--branch",
      "feature/x",
      "--save-new-tests",
    ]);
    const options = r.createFuran.mock.calls[0]![0];
    expect(options).toMatchObject({ branch: "feature/x", saveNewTests: true });
    expect(options.failOnNew).toBeUndefined();
    expect(options.timeoutMs).toBeUndefined();
    const r2 = await run(["upload", dir, "--timeout", "30"]);
    expect(r2.createFuran.mock.calls[0]![0].timeoutMs).toBe(30_000);
  });

  it("api 403 prints code and exits 3", async () => {
    const dir = await tree({ "a.png": null });
    const f = fakeFuran();
    vi.mocked(f.furan.openBuild).mockRejectedValueOnce(
      new FuranApiError({
        status: 403,
        code: "not_a_project_member",
        message: "Not a project member",
        method: "POST",
        path: "projects/p/builds",
        requestId: "x",
      }),
    );
    const r = await run(["upload", dir], { furan: f });
    expect(r.code).toBe(3);
    expect(r.err).toContain("403 not_a_project_member");
    expect(r.err).not.toContain("    at ");
  });

  it("timeout lists pending tests and exits 3", async () => {
    const dir = await tree({ "slow/a.png": null });
    const f = fakeFuran({
      slow: {
        status: "error",
        serverStatus: null,
        error: new FuranTimeoutError("run-slow", "running", 120_000),
      },
    });
    const r = await run(["upload", dir], { furan: f });
    expect(r.code).toBe(3);
    expect(r.out).toContain("slow");
    expect(r.out).toContain("raise --timeout");
  });

  it("unresolved test → 1; all passed → 0", async () => {
    const dir = await tree({ "a/x.png": null, "b/y.png": null });
    const bad = fakeFuran({
      b: { status: "failed", serverStatus: "unresolved" },
    });
    expect((await run(["upload", dir], { furan: bad })).code).toBe(1);
    expect((await run(["upload", dir])).code).toBe(0);
  });

  it("--json prints the machine-readable result", async () => {
    const dir = await tree({ "a/x.png": null });
    const r = await run(["upload", dir, "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ buildId: "b1", exitCode: 0 });
  });

  it("an aborted signal during upload → 130 and open tests aborted", async () => {
    const dir = await tree({ "a/x.png": null, "a/y.png": null });
    const controller = new AbortController();
    const f = fakeFuran();
    // Ctrl-C during the first step's upload.
    const open = f.build.openTest.getMockImplementation()!;
    f.build.openTest.mockImplementation(async (name: string) => {
      const t = await open(name);
      t.check.mockImplementation(async () => {
        controller.abort(new Error("interrupted (SIGINT)"));
      });
      return t;
    });
    const r = await run(["upload", dir, "--concurrency", "1"], {
      furan: f,
      signal: controller.signal,
    });
    expect(r.code).toBe(130);
    expect(f.test("a").abort).toHaveBeenCalled();
  });

  it("--version prints the package version; --help prints usage", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect((await run(["--version"])).out).toBe(pkg.version);
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("furan upload");
  });
});
