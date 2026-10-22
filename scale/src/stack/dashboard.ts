import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { pickPort } from "../ports.js";

import { closeInOrder, type Teardown } from "./teardown.js";

/**
 * Where the harness builds the dashboard, inside `apps/dashboard`. Apart from
 * the `.next` a dev server uses, so a run never disturbs (or is disturbed by)
 * a developer's dashboard. Gitignored.
 */
export const DIST_DIR = ".next-scale";

/** The API base baked into the bundle: root-relative, as behind production's nginx. */
const API_BASE = "/api";

/** Records what the build in DIST_DIR was made from (see `gitSource`). */
const STAMP_FILE = "scale-tree";

/**
 * Tracked files `next build` rewrites in place when `distDir` is not `.next`
 * (it points `next-env.d.ts` at the new types directory and adds it to the
 * `include` of `tsconfig.json`, reformatting the file on the way). The build
 * must not leave the working tree dirty, so each is put back as it was.
 */
const REWRITTEN_BY_NEXT: readonly string[] = ["tsconfig.json", "next-env.d.ts"];

const HEALTH_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;
const HEARTBEAT_MS = 20_000;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all. */
  error?: Error;
}

interface Managed {
  child: ChildProcess;
  exited: Promise<Exit>;
  hasExited(): boolean;
  /** The last lines the process wrote to stdout or stderr. */
  output(): string;
  /** SIGTERM, then SIGKILL after `graceMs`; resolves once the process is gone. */
  stop(graceMs: number): Promise<void>;
}

/** Children still running; a forced exit of the harness kills them (below). */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/** A tracked file as it was before a build rewrote it (undefined: absent). */
interface Snapshot {
  file: string;
  content: Buffer | undefined;
}

/**
 * The tracked files of the build in progress, as they were before it. Set
 * while a build runs and cleared once its own restore is done: a forced exit
 * in between skips that restore, and the exit hook puts them back instead.
 */
let unrestored: readonly Snapshot[] | undefined;

/**
 * Puts back, synchronously, the tracked files a build in progress has
 * rewritten (`REWRITTEN_BY_NEXT`); does nothing when no build is in progress.
 * What the exit hook runs: a forced exit (a second Ctrl-C) must not leave the
 * engineer's `tsconfig.json` or `next-env.d.ts` modified.
 */
export function restoreInterruptedBuild(): void {
  const snapshots = unrestored;
  unrestored = undefined;
  for (const { file, content } of snapshots ?? []) {
    if (content === undefined) continue;
    try {
      const now = existsSync(file) ? readFileSync(file) : undefined;
      if (now === undefined || !now.equals(content)) {
        writeFileSync(file, content);
      }
    } catch {
      // The process is exiting: there is no one left to tell.
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `process.exit()` (a second Ctrl-C skips the cleanup) runs 'exit' listeners
  // synchronously, which is the last chance not to leave a server on its port,
  // or a build's rewrites in the working tree.
  process.on("exit", () => {
    for (const child of live) child.kill("SIGKILL");
    restoreInterruptedBuild();
  });
}

const OUTPUT_LINES = 40;
const OUTPUT_BYTES = 32_768;

/** Terminal colour codes a child writes when its colours are forced on. */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

function spawnManaged(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Managed {
  installExitHook();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.add(child);

  let text = "";
  const collect = (chunk: Buffer): void => {
    text = (text + chunk.toString("utf8")).slice(-OUTPUT_BYTES);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let done = false;
  const exited = new Promise<Exit>((resolve) => {
    child.once("error", (error) => {
      done = true;
      live.delete(child);
      resolve({ code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      done = true;
      live.delete(child);
      resolve({ code, signal });
    });
  });

  return {
    child,
    exited,
    hasExited: () => done,
    output: () =>
      text
        .replace(ANSI, "")
        .trimEnd()
        .split("\n")
        .slice(-OUTPUT_LINES)
        .join("\n"),
    stop: async (graceMs) => {
      if (done) return;
      child.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), graceMs);
      });
      const winner = await Promise.race([exited, timedOut]);
      clearTimeout(timer);
      if (winner === "timeout") {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

function describeExit(exit: Exit): string {
  if (exit.error) return `could not start: ${exit.error.message}`;
  return exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * What the dashboard bundle is made from, as paths in the repository: the app,
 * the workspace packages it imports, and the lockfile and root manifest that
 * pin the versions of everything else. A change to any of them makes a build
 * stale.
 */
export const STAMPED_PATHS: readonly string[] = [
  "apps/dashboard",
  "packages",
  "pnpm-lock.yaml",
  "package.json",
];

/**
 * A build in DIST_DIR is current when it was made from what is committed now
 * (`stamp` is what `headStamp` gives today) and nothing under STAMPED_PATHS has
 * changed since: the rule `--no-build` applies. Pure.
 */
export function canReuseBuild(
  stamp: string | undefined,
  head: string | undefined,
  dirty: boolean,
): boolean {
  return stamp !== undefined && stamp !== "" && stamp === head && !dirty;
}

/**
 * The environment `next build` runs with. Whatever the caller's shell exports
 * for Next (`NEXT_PUBLIC_*` is inlined into the bundle, `NODE_ENV` changes how
 * it is compiled) is dropped, so the bundle is the same from any shell; the
 * harness's own settings (`SCALE_*`) and the runtime-only `API_INTERNAL_URL`
 * are not passed on.
 */
export function buildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (
      name.startsWith("NEXT_") ||
      name.startsWith("SCALE_") ||
      name === "NODE_ENV" ||
      name === "API_INTERNAL_URL"
    ) {
      continue;
    }
    env[name] = value;
  }
  env.NEXT_DIST_DIR = DIST_DIR;
  env.NEXT_PUBLIC_API_URL = API_BASE;
  env.NODE_ENV = "production";
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env;
}

export interface BuildOptions {
  /** Reuse a current build instead of making one (see `canReuseBuild`). */
  noBuild: boolean;
  /** A signal during the build stops it through this. */
  teardown?: Teardown | undefined;
}

/** What `buildDashboard` needs from outside; tests replace each. */
export interface BuildDeps {
  /** The `apps/dashboard` directory. */
  dashboardDir: string;
  /** Runs `next build` there with `env`. */
  runBuild(run: {
    dashboardDir: string;
    env: NodeJS.ProcessEnv;
    teardown?: Teardown | undefined;
  }): Promise<void>;
  /** The committed state of STAMPED_PATHS, as one string (see `gitSource`). */
  headStamp(): Promise<string>;
  /** True when anything under STAMPED_PATHS has uncommitted changes. */
  isDirty(): Promise<boolean>;
  log(message: string): void;
}

/**
 * The two questions `--no-build` asks git, about the repository at `root`.
 * The stamp joins the tree (or blob) ids of STAMPED_PATHS at HEAD, so a commit
 * that changes any of them changes it; `isDirty` is whether `git status` lists
 * anything under them (untracked files included, ignored build output not).
 * Both fail, and so rule out a reuse, when `root` is not a repository.
 */
export function gitSource(
  root: string,
): Pick<BuildDeps, "headStamp" | "isDirty"> {
  const git = async (...args: string[]): Promise<string> =>
    (await execFileAsync("git", args, { cwd: root })).stdout.trim();
  return {
    headStamp: async () =>
      (await git("rev-parse", ...STAMPED_PATHS.map((p) => `HEAD:${p}`)))
        .split("\n")
        .join("+"),
    isDirty: async () =>
      (await git("status", "--porcelain", "--", ...STAMPED_PATHS)) !== "",
  };
}

const repoRoot = (): string =>
  fileURLToPath(new URL("../../../", import.meta.url));

async function runNextBuild(run: {
  dashboardDir: string;
  env: NodeJS.ProcessEnv;
  teardown?: Teardown | undefined;
}): Promise<void> {
  const nextBin = path.join(
    run.dashboardDir,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  if (!existsSync(nextBin)) {
    throw new Error(
      `next is not installed for the dashboard (${nextBin} is missing): run pnpm install`,
    );
  }
  const build = spawnManaged(process.execPath, [nextBin, "build"], {
    cwd: run.dashboardDir,
    env: run.env,
  });
  run.teardown?.add("stop the dashboard build", () =>
    build.stop(KILL_GRACE_MS),
  );
  const exit = await build.exited;
  if (exit.error !== undefined || exit.code !== 0) {
    throw new Error(
      `next build failed (${describeExit(exit)}); the end of its output:\n${build.output()}`,
    );
  }
}

function defaultBuildDeps(): BuildDeps {
  const root = repoRoot();
  return {
    ...gitSource(root),
    dashboardDir: path.join(root, "apps", "dashboard"),
    runBuild: runNextBuild,
    log: (message) => process.stdout.write(`${message}\n`),
  };
}

const serverJsOf = (standaloneDir: string): string =>
  path.join(standaloneDir, "apps", "dashboard", "server.js");

const staticOf = (standaloneDir: string): string =>
  path.join(standaloneDir, "apps", "dashboard", DIST_DIR, "static");

async function readStamp(stampFile: string): Promise<string | undefined> {
  try {
    return (await readFile(stampFile, "utf8")).trim();
  } catch {
    return undefined;
  }
}

/**
 * A production build of the dashboard in `apps/dashboard/.next-scale`, laid out
 * to run as the Dockerfile's image does: `standalone/` is the workspace root
 * holding `apps/dashboard/server.js`, and Next leaves the static assets and
 * `public/` out of it, so they are copied in beside the server.
 *
 * With `noBuild`, a current build is reused (see `canReuseBuild`); otherwise,
 * or when there is none, it builds. The stamp that makes a build reusable is
 * written only for a build made from a clean tree: a build of uncommitted
 * edits must not become "current" if the edits are later thrown away.
 */
export async function buildDashboard(
  opts: BuildOptions,
  deps: BuildDeps = defaultBuildDeps(),
): Promise<{ standaloneDir: string }> {
  const distDir = path.join(deps.dashboardDir, DIST_DIR);
  const standaloneDir = path.join(distDir, "standalone");
  const stampFile = path.join(distDir, STAMP_FILE);

  // Unknown (git failed) counts as "not reusable", and is never stamped.
  const head = await deps.headStamp().catch(() => undefined);
  const dirty = await deps.isDirty().catch(() => true);

  if (opts.noBuild) {
    const stamp = await readStamp(stampFile);
    const complete =
      existsSync(serverJsOf(standaloneDir)) &&
      existsSync(staticOf(standaloneDir));
    if (canReuseBuild(stamp, head, dirty) && complete) {
      deps.log(`reusing the dashboard build in ${distDir}`);
      return { standaloneDir };
    }
    deps.log(
      "--no-build: there is no current dashboard build to reuse (none, or the dashboard, the workspace packages or the lockfile changed since); building",
    );
  }

  deps.log(
    `building the dashboard for production into ${distDir} (about a minute)`,
  );
  const started = performance.now();

  const snapshots: Snapshot[] = await Promise.all(
    REWRITTEN_BY_NEXT.map(async (name) => {
      const file = path.join(deps.dashboardDir, name);
      return {
        file,
        content: existsSync(file) ? await readFile(file) : undefined,
      };
    }),
  );
  await rm(stampFile, { force: true });
  // From here until the restore below has run, a forced exit restores them.
  installExitHook();
  unrestored = snapshots;

  const heartbeat = setInterval(() => {
    deps.log(
      `  still building (${Math.round((performance.now() - started) / 1000)}s)`,
    );
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    await closeInOrder(
      () =>
        deps.runBuild({
          dashboardDir: deps.dashboardDir,
          env: buildEnv(process.env),
          teardown: opts.teardown,
        }),
      // Also after a failed or interrupted build: the tree is left as it was.
      async () => {
        for (const { file, content } of snapshots) {
          if (content === undefined) continue;
          const now = existsSync(file) ? await readFile(file) : undefined;
          if (now === undefined || !now.equals(content)) {
            await writeFile(file, content);
          }
        }
        if (unrestored === snapshots) unrestored = undefined;
      },
    );
  } finally {
    clearInterval(heartbeat);
  }

  const serverJs = serverJsOf(standaloneDir);
  if (!existsSync(serverJs)) {
    throw new Error(`the build produced no ${serverJs}`);
  }
  await copyInto(path.join(distDir, "static"), staticOf(standaloneDir));
  const publicDir = path.join(deps.dashboardDir, "public");
  if (existsSync(publicDir)) {
    await copyInto(
      publicDir,
      path.join(standaloneDir, "apps", "dashboard", "public"),
    );
  }

  if (head !== undefined && !dirty) {
    await writeFile(stampFile, head);
  }
  deps.log(
    `built the dashboard in ${((performance.now() - started) / 1000).toFixed(0)}s`,
  );
  return { standaloneDir };
}

async function copyInto(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface RunningDashboard {
  url: string;
  stop(): Promise<void>;
}

export interface StartDashboardOptions {
  /** The stop is registered here as soon as the process exists. */
  teardown?: Teardown | undefined;
  /** How long `GET /api/healthz` may take to answer 200 (default 60 s). */
  healthTimeoutMs?: number;
  /** How long SIGTERM gets before SIGKILL (default 5 s). */
  killGraceMs?: number;
}

/** Variables the server may inherit; everything else of the harness's stays out. */
const INHERITED_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "TZ",
];

/**
 * Runs the standalone dashboard (`node apps/dashboard/server.js` in
 * `standaloneDir`) on a free loopback port, pointing its server-side calls at
 * `apiUrl`, and returns once its health check answers.
 *
 * The server gets only its own settings: the harness has put the scratch
 * database, storage and signing settings in `process.env`, and a dashboard
 * container never has them.
 */
export async function startDashboard(
  standaloneDir: string,
  apiUrl: string,
  options: StartDashboardOptions = {},
): Promise<RunningDashboard> {
  const serverJs = serverJsOf(standaloneDir);
  if (!existsSync(serverJs)) {
    throw new Error(
      `there is no dashboard build to run (${serverJs} is missing); run without --no-build`,
    );
  }

  const port = await pickPort();
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    API_INTERNAL_URL: apiUrl,
    NEXT_TELEMETRY_DISABLED: "1",
  });

  const server = spawnManaged(
    process.execPath,
    [path.join("apps", "dashboard", "server.js")],
    { cwd: standaloneDir, env },
  );
  const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const stop = (): Promise<void> => server.stop(graceMs);
  options.teardown?.add("stop the dashboard", stop);

  try {
    await waitUntilHealthy(
      url,
      server,
      options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, stop };
}

async function waitUntilHealthy(
  url: string,
  server: Managed,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (server.hasExited()) {
      const exit = await server.exited;
      throw new Error(
        `the dashboard exited (${describeExit(exit)}) before it was healthy:\n${server.output()}`,
      );
    }
    try {
      const response = await fetch(`${url}/api/healthz`, {
        signal: AbortSignal.timeout(2_000),
      });
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `the dashboard did not answer GET /api/healthz with 200 within ${Math.round(timeoutMs / 1000)}s:\n${server.output()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
