import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { Suite } from "./budgets.js";
import type { ShapeName } from "./seed/index.js";

/**
 * The order the suites always run in, whatever order `--suite` names them in
 * (Ruling R25). Every suite changes the seeded project: the browser suite's
 * D3 approves one step, the server suite's R7 approves many, and the pipeline
 * adds batches that become the project's newest (moving `builds.list`'s first
 * page and where `review.next` starts). Least-mutating first, so each suite
 * measures the project as close to the seed as the run allows.
 */
export const SUITE_ORDER: readonly Suite[] = ["browser", "server", "pipeline"];
export const ALL_SUITES: readonly Suite[] = SUITE_ORDER;
const SHAPES: readonly ShapeName[] = ["large", "smoke"];
const STORAGES = ["s3", "hdd"] as const;

/** `scale/out`, wherever the harness is started from (it is gitignored). */
const DEFAULT_REPORT_DIR = fileURLToPath(new URL("../out", import.meta.url));

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CliArgs {
  suites: Suite[];
  shape: ShapeName;
  storage: "s3" | "hdd";
  keep: boolean;
  reuse: boolean;
  noBuild: boolean;
  /** Directory the report is written to, absolute. */
  report: string;
}

export const USAGE = `usage: pnpm --filter @furan/scale scale -- [flags]
  --suite=browser,server,pipeline   suites to run (default: all; "--suite=" runs none);
                                    they always run in this order, whatever order is given
  --shape=large|smoke               seed shape (default: large)
  --storage=s3|hdd                  object storage (default: s3)
  --keep                            keep furan_scale and its storage afterwards
  --reuse                           keep a seed that is already current (needs a --keep run);
                                    a run that started a suite used its seed up, so the
                                    next --reuse reseeds
  --no-build                        skip the dashboard build (browser suite)
  --report=<dir>                    where the report goes (default: scale/out)`;

function pick<T extends string>(
  flag: string,
  value: string,
  allowed: readonly T[],
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(
    `--${flag} must be one of ${allowed.join(", ")} (got "${value}")`,
  );
}

/** `selected` in `SUITE_ORDER`, each once. */
export function runOrder(selected: readonly Suite[]): Suite[] {
  return SUITE_ORDER.filter((suite) => selected.includes(suite));
}

function parseSuites(value: string): Suite[] {
  const suites: Suite[] = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name === "") continue;
    suites.push(pick("suite", name, ALL_SUITES));
  }
  return runOrder(suites);
}

/**
 * Parses the CLI flags. A package manager forwards flags after a `--`, which
 * `node:util` would take as the end of the options, so a leading one is dropped.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        suite: { type: "string" },
        shape: { type: "string" },
        storage: { type: "string" },
        keep: { type: "boolean" },
        reuse: { type: "boolean" },
        "no-build": { type: "boolean" },
        report: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    suites:
      values.suite === undefined ? [...ALL_SUITES] : parseSuites(values.suite),
    shape: pick("shape", values.shape ?? "large", SHAPES),
    storage: pick("storage", values.storage ?? "s3", STORAGES),
    keep: values.keep ?? false,
    reuse: values.reuse ?? false,
    noBuild: values["no-build"] ?? false,
    report:
      values.report === undefined ? DEFAULT_REPORT_DIR : resolve(values.report),
  };
}
