import type {
  CheckOptions,
  Furan,
  ResultStatus,
  TestResult,
} from "@furan/client";
import { vi } from "vitest";

import { parseArgs, type UploadArgs } from "../src/args.js";

/** The parsed args of `furan upload x`, with overrides. */
export function uploadArgs(over: Partial<UploadArgs> = {}): UploadArgs {
  const parsed = parseArgs(["upload", "x"]);
  if (parsed.kind !== "upload") throw new Error("unreachable");
  return { ...parsed.args, ...over };
}

export interface FakeTest {
  name: string;
  runId: string;
  url: string;
  steps: string[];
  check: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  result: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

/**
 * A Furan whose build and tests record every call in `events` (in order) and
 * whose tests settle with `outcomes[name]` (default passed).
 */
export function fakeFuran(
  outcomes: Record<string, Partial<TestResult>> = {},
  config: { failOnNew?: boolean } = {},
) {
  const events: string[] = [];
  const stats = { inFlight: 0, maxInFlight: 0 };
  const tests: FakeTest[] = [];
  const dash = "https://d/projects/p";

  const makeTest = (name: string): FakeTest => {
    const steps: string[] = [];
    const runId = `run-${name}`;
    const report = (status: ResultStatus): TestResult => ({
      name,
      runId,
      status,
      serverStatus: status === "passed" ? "passed" : null,
      steps: [...steps],
      url: `${dash}/runs/${runId}`,
      ...outcomes[name],
    });
    return {
      name,
      runId,
      url: `${dash}/runs/${runId}`,
      steps,
      check: vi.fn(
        async (step: string, _png: Uint8Array, _o?: CheckOptions) => {
          stats.inFlight++;
          stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
          events.push(`${name}:check:${step}`);
          await new Promise((r) => setTimeout(r, 2));
          steps.push(step);
          stats.inFlight--;
        },
      ),
      complete: vi.fn(async () => {
        events.push(`${name}:complete`);
      }),
      result: vi.fn(async (_opts?: unknown) => {
        events.push(`${name}:result`);
        return report("passed");
      }),
      close: vi.fn(async (opts?: { wait?: boolean }) => {
        events.push(`${name}:close`);
        return opts?.wait === false
          ? { ...report("passed"), status: "uploaded" }
          : report("passed");
      }),
      abort: vi.fn(async () => {
        events.push(`${name}:abort`);
      }),
    };
  };

  const build = {
    id: "b1",
    url: `${dash}/builds/b1`,
    openTest: vi.fn(async (name: string) => {
      const t = makeTest(name);
      tests.push(t);
      events.push(`${name}:open`);
      return t;
    }),
  };
  const furan = {
    config: {
      branch: "main",
      failOnNew: config.failOnNew ?? false,
      timeoutMs: 120_000,
    },
    openBuild: vi.fn(async () => build),
  };
  return {
    furan: furan as unknown as Furan,
    build,
    events,
    stats,
    tests,
    test: (name: string) => tests.find((t) => t.name === name)!,
  };
}
