import type { FuranConfig } from "./config.js";
import { FuranInputError, FuranTimeoutError } from "./errors.js";
import { pngSize } from "./png.js";
import { Transport } from "./transport.js";
import {
  MAX_REGIONS_PER_KIND,
  type AccessibilityBox,
  type Box,
  type Build,
  type CheckpointRef,
  type FloatingBox,
  type MatchLevel,
  type Regions,
  type Run,
} from "./types.js";

export interface UploadInput {
  name: string;
  png: Uint8Array;
  /** `WIDTHxHEIGHT`; default: the PNG's size. */
  viewport?: string;
  /** Default `image`, the Kotlin raw-image label. */
  browser?: string;
  os?: string | null;
  device?: string | null;
  matchLevel?: MatchLevel;
  regions?: Partial<Regions>;
  ignoreDisplacements?: boolean;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/** Statuses that mean the diff pipeline has not settled the run yet. */
const IN_PROGRESS = new Set(["running", "pending", "queued", "processing"]);

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** One method per SDK route (spec §2). */
export class FuranClient {
  private readonly transport: Transport;
  private readonly projectId: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: Pick<FuranConfig, "apiUrl" | "token" | "projectId">,
    opts: ClientOptions = {},
  ) {
    this.projectId = config.projectId;
    this.sleep = opts.sleep ?? sleepFor;
    this.transport = new Transport({
      apiUrl: config.apiUrl,
      token: config.token,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      sleep: this.sleep,
      ...(opts.random ? { random: opts.random } : {}),
    });
  }

  /** Create a build, or join the project's build with this `ciBuildId`. */
  async createBuild(input: {
    ciBuildId?: string;
    branch?: string;
    name?: string;
    number?: number;
    properties?: Record<string, string>;
  }): Promise<Build> {
    const body: Record<string, unknown> = {};
    if (input.ciBuildId !== undefined) body.ciBuildId = input.ciBuildId;
    if (input.branch !== undefined) body.branchName = input.branch;
    if (input.name !== undefined) body.name = input.name;
    if (input.number !== undefined) body.number = input.number;
    if (input.properties && Object.keys(input.properties).length > 0) {
      body.properties = input.properties;
    }
    const row = await this.transport.request<Record<string, unknown>>(
      "POST",
      `projects/${this.projectId}/builds`,
      body,
    );
    return {
      id: String(row.id),
      projectId: str(row.projectId) ?? this.projectId,
      ciBuildId: str(row.ciBuildId),
      branchName: str(row.branchName),
      name: str(row.name),
      number: typeof row.number === "number" ? row.number : null,
    };
  }

  async createRun(input: {
    buildId: string;
    name: string;
    branch: string;
    parentBranch?: string;
  }): Promise<{ runId: string; status: string; name: string }> {
    return this.transport.request("POST", "runs", {
      projectId: this.projectId,
      buildId: input.buildId,
      name: input.name,
      branchName: input.branch,
      ...(input.parentBranch !== undefined
        ? { parentBranchName: input.parentBranch }
        : {}),
    });
  }

  async uploadCheckpoint(
    runId: string,
    input: UploadInput,
  ): Promise<CheckpointRef> {
    const size = pngSize(input.png);
    const form = new FormData();
    form.append("name", input.name);
    form.append("viewport", input.viewport ?? `${size.width}x${size.height}`);
    form.append("browser", input.browser ?? "image");
    if (input.os) form.append("os", input.os);
    if (input.device) form.append("device", input.device);
    form.append("matchLevel", input.matchLevel ?? "Strict");
    form.append("regions", JSON.stringify(wireRegions(input.regions ?? {})));
    if (input.ignoreDisplacements) form.append("ignoreDisplacements", "true");
    form.append(
      "pngBytes",
      new Blob([input.png], { type: "image/png" }),
      "snap.png",
    );
    const res = await this.transport.request<{
      checkpointId: string;
      testVariationId: string;
    }>("POST", `runs/${runId}/screenshots`, form);
    return {
      checkpointId: res.checkpointId,
      testVariationId: res.testVariationId,
    };
  }

  /** Close the run; the diff pipeline, not this call, decides its verdict. */
  async completeRun(
    runId: string,
  ): Promise<{ runId: string; status: string; checkpointCount: number }> {
    return this.transport.request("POST", `runs/${runId}/complete`, {});
  }

  async getRun(runId: string): Promise<Run> {
    const row = await this.transport.request<Record<string, unknown>>(
      "GET",
      `runs/${runId}`,
    );
    return {
      id: String(row.id),
      projectId: String(row.projectId),
      buildId: String(row.buildId),
      name: String(row.name),
      status: String(row.status),
      branchName: str(row.branchName),
      checkpointCount:
        typeof row.checkpointCount === "number" ? row.checkpointCount : null,
      autoApproved: row.autoApproved === true,
    };
  }

  /** Poll `GET /runs/:id` while the diff pipeline is still working on it. */
  async waitForRun(runId: string, opts: WaitOptions = {}): Promise<Run> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      opts.signal?.throwIfAborted();
      const run = await this.getRun(runId);
      if (!IN_PROGRESS.has(run.status)) return run;
      if (Date.now() + intervalMs >= deadline) {
        throw new FuranTimeoutError(runId, run.status, timeoutMs);
      }
      await this.sleep(intervalMs);
    }
  }

  /** Approve the run's pending steps (save-new-tests). */
  async approveRun(runId: string): Promise<void> {
    await this.transport.request("POST", `runs/${runId}/approve`, {});
  }

  /** Mark the run aborted. Best effort: errors are swallowed. */
  async abortRun(runId: string): Promise<void> {
    try {
      await this.transport.request("POST", `runs/${runId}/abort`, {});
    } catch {
      // A run left open is finalized by the server's reconciler.
    }
  }
}

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FuranInputError(`${what} must be a finite number`);
  }
  return value;
}

function box(b: Box): Box {
  return {
    x: num(b.x, "region x"),
    y: num(b.y, "region y"),
    width: num(b.width, "region width"),
    height: num(b.height, "region height"),
  };
}

function floating(b: FloatingBox): FloatingBox {
  const out: FloatingBox = box(b);
  for (const key of [
    "maxUpOffset",
    "maxDownOffset",
    "maxLeftOffset",
    "maxRightOffset",
  ] as const) {
    if (b[key] !== undefined) out[key] = num(b[key], `region ${key}`);
  }
  return out;
}

/** The five kinds in the api's order, each box with only its known keys. */
function wireRegions(regions: Partial<Regions>): Regions {
  const kinds = {
    ignore: regions.ignore ?? [],
    layout: regions.layout ?? [],
    floating: regions.floating ?? [],
    content: regions.content ?? [],
    accessibility: regions.accessibility ?? [],
  };
  for (const [kind, list] of Object.entries(kinds)) {
    if (list.length > MAX_REGIONS_PER_KIND) {
      throw new FuranInputError(
        `at most ${MAX_REGIONS_PER_KIND} ${kind} regions per checkpoint (got ${list.length})`,
      );
    }
  }
  return {
    ignore: kinds.ignore.map(box),
    layout: kinds.layout.map(box),
    floating: kinds.floating.map(floating),
    content: kinds.content.map(box),
    accessibility: kinds.accessibility.map(
      (b: AccessibilityBox): AccessibilityBox => ({ ...box(b), type: b.type }),
    ),
  };
}
