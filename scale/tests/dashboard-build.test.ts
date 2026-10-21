import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDashboard,
  buildEnv,
  canReuseBuild,
  startDashboard,
  type BuildDeps,
} from "../src/stack/dashboard.js";
import { Teardown } from "../src/stack/teardown.js";

describe("canReuseBuild", () => {
  it("is true only when the stamp is the HEAD tree and nothing is uncommitted", () => {
    expect(canReuseBuild("tree-a", "tree-a", false)).toBe(true);
    expect(canReuseBuild("tree-a", "tree-a", true)).toBe(false);
    expect(canReuseBuild("tree-a", "tree-b", false)).toBe(false);
    expect(canReuseBuild("tree-a", "tree-b", true)).toBe(false);
  });

  it("is false without a stamp", () => {
    expect(canReuseBuild(undefined, "tree-a", false)).toBe(false);
    expect(canReuseBuild("", "", false)).toBe(false);
    expect(canReuseBuild(undefined, undefined, false)).toBe(false);
  });
});

describe("buildEnv", () => {
  it("sets the dist dir, the single-origin API base and production mode", () => {
    const env = buildEnv({ PATH: "/bin", HOME: "/home/x" });
    expect(env.NEXT_DIST_DIR).toBe(".next-scale");
    expect(env.NEXT_PUBLIC_API_URL).toBe("/api");
    expect(env.NODE_ENV).toBe("production");
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/x");
  });

  it("drops what would change the bundle or leak the harness's settings", () => {
    const env = buildEnv({
      PATH: "/bin",
      NODE_ENV: "test",
      NEXT_PUBLIC_API_URL: "http://localhost:3000",
      NEXT_PUBLIC_WORKSPACE_NAME: "mine",
      NEXT_DIST_DIR: ".next",
      API_INTERNAL_URL: "http://api:3000",
      SCALE_DATABASE_URL: "postgres://scale",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.NEXT_PUBLIC_API_URL).toBe("/api");
    expect(env.NEXT_DIST_DIR).toBe(".next-scale");
    expect(env.NEXT_PUBLIC_WORKSPACE_NAME).toBeUndefined();
    expect(env.API_INTERNAL_URL).toBeUndefined();
    expect(env.SCALE_DATABASE_URL).toBeUndefined();
  });
});

/** A throwaway apps/dashboard with the two tracked files a build rewrites. */
describe("buildDashboard", () => {
  let dir: string;
  let builds: Array<{ env: NodeJS.ProcessEnv }>;
  let tree: string;
  let dirty: boolean;
  let build: (dashboardDir: string) => Promise<void>;

  const TSCONFIG = '{\n  "include": ["src/**/*.ts"]\n}\n';
  const NEXT_ENV = '/// <reference path="./.next/types/routes.d.ts" />\n';

  const deps = (): BuildDeps => ({
    dashboardDir: dir,
    runBuild: async ({ dashboardDir, env }) => {
      builds.push({ env });
      await build(dashboardDir);
    },
    headTree: async () => tree,
    isDirty: async () => dirty,
    log: () => undefined,
  });

  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scale-dashboard-"));
    builds = [];
    tree = "tree-1";
    dirty = false;
    await write(path.join(dir, "tsconfig.json"), TSCONFIG);
    await write(path.join(dir, "next-env.d.ts"), NEXT_ENV);
    await write(path.join(dir, "public", "robots.txt"), "User-agent: *\n");
    // What `next build` leaves, plus what it rewrites on the way.
    build = async (dashboardDir) => {
      const out = path.join(dashboardDir, ".next-scale");
      await write(
        path.join(out, "standalone", "apps", "dashboard", "server.js"),
        "// server\n",
      );
      await write(
        path.join(
          out,
          "standalone",
          "apps",
          "dashboard",
          ".next-scale",
          "BUILD_ID",
        ),
        "id\n",
      );
      await write(path.join(out, "static", "chunks", "a.js"), "// a\n");
      await write(
        path.join(dashboardDir, "tsconfig.json"),
        '{"include":["src/**/*.ts",".next-scale/types/**/*.ts"]}',
      );
      await write(
        path.join(dashboardDir, "next-env.d.ts"),
        '/// <reference path="./.next-scale/types/routes.d.ts" />\n',
      );
    };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const standalone = () => path.join(dir, ".next-scale", "standalone");
  const app = () => path.join(standalone(), "apps", "dashboard");

  it("builds into .next-scale for production behind /api", async () => {
    const result = await buildDashboard({ noBuild: false }, deps());

    expect(result.standaloneDir).toBe(standalone());
    expect(builds).toHaveLength(1);
    expect(builds[0]!.env.NEXT_DIST_DIR).toBe(".next-scale");
    expect(builds[0]!.env.NEXT_PUBLIC_API_URL).toBe("/api");
    expect(builds[0]!.env.NODE_ENV).toBe("production");
  });

  it("copies static and public next to the standalone server and stamps the tree", async () => {
    await buildDashboard({ noBuild: false }, deps());

    expect(
      await readFile(
        path.join(app(), ".next-scale", "static", "chunks", "a.js"),
        "utf8",
      ),
    ).toBe("// a\n");
    expect(
      await readFile(path.join(app(), "public", "robots.txt"), "utf8"),
    ).toBe("User-agent: *\n");
    // The build's own server output is still there.
    expect(existsSync(path.join(app(), ".next-scale", "BUILD_ID"))).toBe(true);
    expect(
      await readFile(path.join(dir, ".next-scale", "scale-tree"), "utf8"),
    ).toBe("tree-1");
  });

  it("copes with an app that has no public directory", async () => {
    await rm(path.join(dir, "public"), { recursive: true });
    await buildDashboard({ noBuild: false }, deps());
    expect(existsSync(path.join(app(), "public"))).toBe(false);
    expect(
      existsSync(path.join(app(), ".next-scale", "static", "chunks", "a.js")),
    ).toBe(true);
  });

  it("restores the tracked files the build rewrites, byte for byte", async () => {
    await buildDashboard({ noBuild: false }, deps());
    expect(await readFile(path.join(dir, "tsconfig.json"), "utf8")).toBe(
      TSCONFIG,
    );
    expect(await readFile(path.join(dir, "next-env.d.ts"), "utf8")).toBe(
      NEXT_ENV,
    );
  });

  it("restores them when the build fails, and reports the build's failure", async () => {
    build = async (dashboardDir) => {
      await write(path.join(dashboardDir, "tsconfig.json"), "{}");
      await write(path.join(dashboardDir, "next-env.d.ts"), "// changed\n");
      throw new Error("next build failed (exit 1)");
    };
    await expect(buildDashboard({ noBuild: false }, deps())).rejects.toThrow(
      "next build failed (exit 1)",
    );
    expect(await readFile(path.join(dir, "tsconfig.json"), "utf8")).toBe(
      TSCONFIG,
    );
    expect(await readFile(path.join(dir, "next-env.d.ts"), "utf8")).toBe(
      NEXT_ENV,
    );
    expect(existsSync(path.join(dir, ".next-scale", "scale-tree"))).toBe(false);
  });

  it("does not touch a file the build left alone", async () => {
    build = async (dashboardDir) => {
      await write(
        path.join(
          dashboardDir,
          ".next-scale",
          "standalone",
          "apps",
          "dashboard",
          "server.js",
        ),
        "// server\n",
      );
      await write(
        path.join(dashboardDir, ".next-scale", "static", "a.js"),
        "// a\n",
      );
    };
    const before = (await stat(path.join(dir, "tsconfig.json"))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await buildDashboard({ noBuild: false }, deps());
    expect((await stat(path.join(dir, "tsconfig.json"))).mtimeMs).toBe(before);
  });

  it("fails when the build left no server to run", async () => {
    build = async () => undefined;
    await expect(buildDashboard({ noBuild: false }, deps())).rejects.toThrow(
      /server\.js/,
    );
  });

  it("noBuild reuses a build made from the committed tree", async () => {
    await buildDashboard({ noBuild: false }, deps());
    expect(builds).toHaveLength(1);

    const again = await buildDashboard({ noBuild: true }, deps());
    expect(again.standaloneDir).toBe(standalone());
    expect(builds).toHaveLength(1);
  });

  it("noBuild builds when there is no stamp", async () => {
    await buildDashboard({ noBuild: true }, deps());
    expect(builds).toHaveLength(1);
  });

  it("noBuild builds when the dashboard changed since the stamp", async () => {
    await buildDashboard({ noBuild: false }, deps());
    tree = "tree-2";
    await buildDashboard({ noBuild: true }, deps());
    expect(builds).toHaveLength(2);
    expect(
      await readFile(path.join(dir, ".next-scale", "scale-tree"), "utf8"),
    ).toBe("tree-2");
  });

  it("noBuild builds when there are uncommitted changes", async () => {
    await buildDashboard({ noBuild: false }, deps());
    dirty = true;
    await buildDashboard({ noBuild: true }, deps());
    expect(builds).toHaveLength(2);
  });

  it("noBuild builds when the output is incomplete", async () => {
    await buildDashboard({ noBuild: false }, deps());
    await rm(path.join(app(), "server.js"));
    await buildDashboard({ noBuild: true }, deps());
    expect(builds).toHaveLength(2);
  });

  it("builds anyway without noBuild, whatever the stamp says", async () => {
    await buildDashboard({ noBuild: false }, deps());
    await buildDashboard({ noBuild: false }, deps());
    expect(builds).toHaveLength(2);
  });

  it("does not stamp a build made from uncommitted changes", async () => {
    // Stamping it would let `git checkout .` turn it into a "current" build.
    dirty = true;
    await buildDashboard({ noBuild: false }, deps());
    expect(existsSync(path.join(dir, ".next-scale", "scale-tree"))).toBe(false);

    dirty = false;
    await buildDashboard({ noBuild: true }, deps());
    expect(builds).toHaveLength(2);
  });

  it("treats a git failure as no build to reuse, and stamps nothing", async () => {
    const noGit: BuildDeps = {
      ...deps(),
      headTree: async () => {
        throw new Error("not a git repository");
      },
    };
    await buildDashboard({ noBuild: false }, noGit);
    await buildDashboard({ noBuild: true }, noGit);
    expect(builds).toHaveLength(2);
    expect(existsSync(path.join(dir, ".next-scale", "scale-tree"))).toBe(false);
  });
});

/**
 * A stand-in for the standalone `server.js`: serves what it was started with.
 * Its behaviour comes from `stub.json` beside it (the harness passes the
 * server no environment of the test's choosing).
 */
const STUB_SERVER = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "stub.json"), "utf8"));
const startedAt = Date.now();
if (cfg.exitCode) {
  console.error("\\u001b[31mstub: refusing to start\\u001b[39m");
  process.exit(cfg.exitCode);
}
if (cfg.ignoreSigterm) process.on("SIGTERM", () => {});
http.createServer((req, res) => {
  if (req.url === "/api/healthz") {
    if (Date.now() - startedAt < (cfg.healthyAfterMs || 0)) { res.statusCode = 503; return res.end("starting"); }
    res.end("ok"); return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    port: process.env.PORT,
    hostname: process.env.HOSTNAME,
    apiInternalUrl: process.env.API_INTERNAL_URL,
    nodeEnv: process.env.NODE_ENV,
    cwd: process.cwd(),
    leaked: Object.keys(process.env).filter((k) => k.startsWith("SCALE_") || k === "JWT_SECRET"),
  }));
}).listen(Number(process.env.PORT), process.env.HOSTNAME);
`;

interface StubConfig {
  healthyAfterMs?: number;
  exitCode?: number;
  ignoreSigterm?: boolean;
}

describe("startDashboard", () => {
  let dir: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scale-standalone-"));
    await mkdir(path.join(dir, "apps", "dashboard"), { recursive: true });
    await writeFile(
      path.join(dir, "apps", "dashboard", "server.js"),
      STUB_SERVER,
    );
    await configure({});
  });

  const configure = (config: StubConfig) =>
    writeFile(
      path.join(dir, "apps", "dashboard", "stub.json"),
      JSON.stringify(config),
    );

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    delete process.env.SCALE_TEST_SECRET;
    delete process.env.JWT_SECRET;
    await rm(dir, { recursive: true, force: true });
  });

  it("runs apps/dashboard/server.js with its port, host and the api's address", async () => {
    process.env.SCALE_TEST_SECRET = "must-not-leak";
    process.env.JWT_SECRET = "must-not-leak";
    const dashboard = await startDashboard(dir, "http://127.0.0.1:41999");
    stops.push(dashboard.stop);

    const url = new URL(dashboard.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect([3000, 3001, 5433, 6380, 9000]).not.toContain(Number(url.port));

    const seen = (await (await fetch(`${dashboard.url}/env`)).json()) as {
      port: string;
      hostname: string;
      apiInternalUrl: string;
      nodeEnv: string;
      cwd: string;
      leaked: string[];
    };
    expect(seen.port).toBe(url.port);
    expect(seen.hostname).toBe("127.0.0.1");
    expect(seen.apiInternalUrl).toBe("http://127.0.0.1:41999");
    expect(seen.nodeEnv).toBe("production");
    // The harness's database, storage and signing settings stay with the harness.
    expect(seen.leaked).toEqual([]);
  });

  it("waits for GET /api/healthz to answer 200", async () => {
    await configure({ healthyAfterMs: 700 });
    const started = performance.now();
    const dashboard = await startDashboard(dir, "http://127.0.0.1:41999");
    stops.push(dashboard.stop);
    expect(performance.now() - started).toBeGreaterThanOrEqual(600);
    expect((await fetch(`${dashboard.url}/api/healthz`)).status).toBe(200);
  });

  it("stop() ends the process and frees the port", async () => {
    const dashboard = await startDashboard(dir, "http://127.0.0.1:41999");
    await dashboard.stop();
    await expect(fetch(`${dashboard.url}/api/healthz`)).rejects.toThrow();
    // Idempotent.
    await dashboard.stop();
  });

  it("stop() kills a process that ignores SIGTERM after the grace period", async () => {
    await configure({ ignoreSigterm: true });
    const dashboard = await startDashboard(dir, "http://127.0.0.1:41999", {
      killGraceMs: 300,
    });
    const started = performance.now();
    await dashboard.stop();
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
    await expect(fetch(`${dashboard.url}/api/healthz`)).rejects.toThrow();
  });

  it("registers its stop on the teardown", async () => {
    const teardown = new Teardown();
    const dashboard = await startDashboard(dir, "http://127.0.0.1:41999", {
      teardown,
    });
    expect((await fetch(`${dashboard.url}/api/healthz`)).status).toBe(200);

    const results = await teardown.run();
    expect(results.filter((r) => r.error !== undefined)).toEqual([]);
    expect(results).toHaveLength(1);
    await expect(fetch(`${dashboard.url}/api/healthz`)).rejects.toThrow();
  });

  it("fails fast, with its output, when the server exits before it is healthy", async () => {
    await configure({ exitCode: 3 });
    const started = performance.now();
    await expect(startDashboard(dir, "http://127.0.0.1:41999")).rejects.toThrow(
      /exited.*3[\s\S]*refusing to start/,
    );
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("shows that output without terminal colour codes", async () => {
    await configure({ exitCode: 3 });
    const error = (await startDashboard(dir, "http://127.0.0.1:41999").catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.message).toContain("stub: refusing to start");
    expect(error.message).not.toContain("\u001b");
  });

  it("gives up, and stops the server, when it never becomes healthy", async () => {
    await configure({ healthyAfterMs: 600_000 });
    const teardown = new Teardown();
    await expect(
      startDashboard(dir, "http://127.0.0.1:41999", {
        healthTimeoutMs: 800,
        teardown,
      }),
    ).rejects.toThrow(/healthz/);
    // Nothing is left running: the teardown's stop has nothing to wait for.
    const results = await teardown.run();
    expect(results.filter((r) => r.error !== undefined)).toEqual([]);
  });

  it("names the missing build when there is no server.js", async () => {
    await rm(path.join(dir, "apps", "dashboard", "server.js"));
    await expect(startDashboard(dir, "http://127.0.0.1:41999")).rejects.toThrow(
      /server\.js/,
    );
  });
});
