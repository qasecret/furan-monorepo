import { FuranClient, type UploadInput } from "./client.js";
import {
  resolveConfig,
  type FuranConfig,
  type FuranOptions,
} from "./config.js";
import { FuranError } from "./errors.js";
import type {
  Box,
  CheckpointRef,
  FloatingBox,
  MatchLevel,
  ResultStatus,
  Run,
  TestResult,
} from "./types.js";
import { toResultStatus } from "./verdict.js";

export interface CheckOptions {
  ignore?: Box[];
  layout?: Box[];
  content?: Box[];
  floating?: FloatingBox[];
  matchLevel?: MatchLevel;
  viewport?: string;
  browser?: string;
  os?: string | null;
  device?: string | null;
  ignoreDisplacements?: boolean;
}

/**
 * The entry point: a resolved config and a client. `openBuild()` opens (or
 * joins) this pipeline's build once; tests are opened on that build.
 */
export class Furan {
  readonly client: FuranClient;
  private building: Promise<FuranBuild> | null = null;

  /** Resolve config from options, `FURAN_*` env and the CI environment. */
  static fromEnv(
    options?: FuranOptions,
    env: NodeJS.ProcessEnv = process.env,
  ): Furan {
    return new Furan(resolveConfig(options, env));
  }

  constructor(
    readonly config: FuranConfig,
    client?: FuranClient,
  ) {
    this.client = client ?? new FuranClient(config);
  }

  /** The build every test of this process goes into; created once. */
  openBuild(): Promise<FuranBuild> {
    this.building ??= this.createBuild().catch((err: unknown) => {
      this.building = null;
      throw err;
    });
    return this.building;
  }

  buildUrl(buildId: string): string | null {
    return this.link(`builds/${buildId}`);
  }

  runUrl(runId: string): string | null {
    return this.link(`runs/${runId}`);
  }

  private link(path: string): string | null {
    const { dashboardUrl, projectId } = this.config;
    return dashboardUrl
      ? `${dashboardUrl}/projects/${projectId}/${path}`
      : null;
  }

  private async createBuild(): Promise<FuranBuild> {
    const c = this.config;
    if (c.buildId !== null) return new FuranBuild(this, c.buildId);
    const build = await this.client.createBuild({
      ...(c.ciBuildId !== null ? { ciBuildId: c.ciBuildId } : {}),
      branch: c.branch,
      ...(c.buildName !== null ? { name: c.buildName } : {}),
      ...(c.buildNumber !== null ? { number: c.buildNumber } : {}),
      properties: c.properties,
    });
    return new FuranBuild(this, build.id);
  }
}

/** A build (the dashboard's batch). */
export class FuranBuild {
  readonly url: string | null;

  constructor(
    private readonly furan: Furan,
    readonly id: string,
  ) {
    this.url = furan.buildUrl(id);
  }

  /** Open one test (a run) in this build. */
  async openTest(name: string): Promise<FuranTest> {
    const { branch, parentBranch } = this.furan.config;
    const run = await this.furan.client.createRun({
      buildId: this.id,
      name,
      branch,
      ...(parentBranch !== null ? { parentBranch } : {}),
    });
    return new FuranTest(this.furan, name, run.runId);
  }
}

type TestState = "open" | "completed" | "skipped" | "aborted";

/** One test: its steps are uploaded with `check`, then it is completed and judged. */
export class FuranTest {
  readonly url: string | null;
  private readonly stepNames: string[] = [];
  private state: TestState = "open";

  constructor(
    private readonly furan: Furan,
    readonly name: string,
    readonly runId: string,
  ) {
    this.url = furan.runUrl(runId);
  }

  get steps(): readonly string[] {
    return this.stepNames;
  }

  /** Upload one step. Environment labels default to the config's. */
  async check(
    name: string,
    png: Uint8Array,
    options: CheckOptions = {},
  ): Promise<CheckpointRef> {
    if (this.state !== "open") {
      throw new FuranError(`test "${this.name}" is already ${this.state}`);
    }
    const c = this.furan.config;
    const input: UploadInput = {
      name,
      png,
      browser: options.browser ?? c.browser ?? "image",
      os: options.os !== undefined ? options.os : c.os,
      device: options.device !== undefined ? options.device : c.device,
      regions: {
        ignore: options.ignore ?? [],
        layout: options.layout ?? [],
        content: options.content ?? [],
        floating: options.floating ?? [],
      },
    };
    if (options.viewport !== undefined) input.viewport = options.viewport;
    if (options.matchLevel !== undefined) input.matchLevel = options.matchLevel;
    if (options.ignoreDisplacements !== undefined) {
      input.ignoreDisplacements = options.ignoreDisplacements;
    }
    const ref = await this.furan.client.uploadCheckpoint(this.runId, input);
    this.stepNames.push(name);
    return ref;
  }

  /**
   * Close the test after its last upload. A test with no steps is aborted
   * instead (an empty run would read as passed). Idempotent.
   */
  async complete(): Promise<void> {
    if (this.state !== "open") return;
    if (this.stepNames.length === 0) {
      await this.furan.client.abortRun(this.runId);
      this.state = "skipped";
      return;
    }
    await this.furan.client.completeRun(this.runId);
    this.state = "completed";
  }

  /**
   * Wait for the verdict (completing first if needed), approve a first
   * baseline under `saveNewTests`, and report. An api error or the deadline
   * becomes an `error` result; only an aborted `signal` throws.
   */
  async result(
    opts: { deadline?: number; signal?: AbortSignal } = {},
  ): Promise<TestResult> {
    await this.complete();
    if (this.state === "skipped") return this.report("skipped", null);
    if (this.state === "aborted") {
      return this.report("error", null, new FuranError("the test was aborted"));
    }
    const c = this.furan.config;
    let run: Run | null = null;
    try {
      run = await this.furan.client.waitForRun(this.runId, {
        timeoutMs:
          opts.deadline !== undefined
            ? Math.max(1, opts.deadline - Date.now())
            : c.timeoutMs,
        intervalMs: c.pollIntervalMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      let status: ResultStatus = toResultStatus(run);
      if (status === "new" && c.saveNewTests) {
        await this.furan.client.approveRun(this.runId);
        status = "passed";
      }
      return this.report(status, run.status);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return this.report(
        "error",
        run?.status ?? null,
        err instanceof Error ? err : new FuranError(String(err)),
      );
    }
  }

  /** `complete()` then `result()`; with `wait: false`, report `uploaded`. */
  async close(opts: { wait?: boolean } = {}): Promise<TestResult> {
    await this.complete();
    if (opts.wait === false && this.state === "completed") {
      return this.report("uploaded", null);
    }
    return this.result();
  }

  /** Abort an open test (best effort), e.g. when its upload failed. */
  async abort(): Promise<void> {
    if (this.state !== "open") return;
    this.state = "aborted";
    await this.furan.client.abortRun(this.runId);
  }

  private report(
    status: ResultStatus,
    serverStatus: string | null,
    error?: Error,
  ): TestResult {
    return {
      name: this.name,
      runId: this.runId,
      status,
      serverStatus,
      steps: [...this.stepNames],
      url: this.url,
      ...(error ? { error } : {}),
    };
  }
}
