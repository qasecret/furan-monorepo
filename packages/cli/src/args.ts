import { parseArgs as nodeParseArgs } from "node:util";

import { MATCH_LEVELS, type Box, type MatchLevel } from "@furan/client";

/** The command line is wrong; nothing was sent. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface UploadArgs {
  paths: string[];
  test: string | null;
  ignore: Box[];
  matchLevel: MatchLevel | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  viewport: string | null;
  branch: string | null;
  parentBranch: string | null;
  buildName: string | null;
  ciBuildId: string | null;
  saveNewTests: boolean;
  failOnNew: boolean;
  wait: boolean;
  /** Null when `--timeout` is not given, so FURAN_POLL_TIMEOUT_SECONDS applies. */
  timeoutSeconds: number | null;
  concurrency: number;
  json: boolean;
  dryRun: boolean;
}

export type ParsedArgs =
  { kind: "upload"; args: UploadArgs } | { kind: "help" } | { kind: "version" };

const OPTIONS = {
  test: { type: "string" },
  ignore: { type: "string", multiple: true },
  "match-level": { type: "string" },
  browser: { type: "string" },
  os: { type: "string" },
  device: { type: "string" },
  viewport: { type: "string" },
  branch: { type: "string" },
  "parent-branch": { type: "string" },
  "build-name": { type: "string" },
  "ci-build-id": { type: "string" },
  "save-new-tests": { type: "boolean" },
  "fail-on-new": { type: "boolean" },
  "no-wait": { type: "boolean" },
  timeout: { type: "string" },
  concurrency: { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/** Parse `furan <command> …`. Throws {@link UsageError} on a bad command line. */
export function parseArgs(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const [command, ...paths] = positionals;
  if (command === undefined) return { kind: "help" };
  if (command !== "upload") {
    throw new UsageError(`unknown command "${command}" (try: furan upload)`);
  }
  if (paths.length === 0) {
    throw new UsageError("upload needs at least one PNG file or folder");
  }

  const matchLevel = values["match-level"] ?? null;
  if (matchLevel !== null && !MATCH_LEVELS.includes(matchLevel as MatchLevel)) {
    throw new UsageError(
      `--match-level must be one of ${MATCH_LEVELS.join(", ")} (got "${matchLevel}")`,
    );
  }
  const viewport = values.viewport ?? null;
  if (viewport !== null && !/^\d+x\d+$/.test(viewport)) {
    throw new UsageError(`--viewport expects WIDTHxHEIGHT (got "${viewport}")`);
  }

  return {
    kind: "upload",
    args: {
      paths,
      test: values.test ?? null,
      ignore: (values.ignore ?? []).map(parseBox),
      matchLevel: matchLevel as MatchLevel | null,
      browser: values.browser ?? null,
      os: values.os ?? null,
      device: values.device ?? null,
      viewport,
      branch: values.branch ?? null,
      parentBranch: values["parent-branch"] ?? null,
      buildName: values["build-name"] ?? null,
      ciBuildId: values["ci-build-id"] ?? null,
      saveNewTests: values["save-new-tests"] ?? false,
      failOnNew: values["fail-on-new"] ?? false,
      wait: !(values["no-wait"] ?? false),
      timeoutSeconds:
        values.timeout === undefined
          ? null
          : positiveInt(values.timeout, "--timeout", 120),
      concurrency: Math.min(
        16,
        Math.max(1, wholeNumber(values.concurrency, "--concurrency", 4)),
      ),
      json: values.json ?? false,
      dryRun: values["dry-run"] ?? false,
    },
  };
}

function wholeNumber(
  value: string | undefined,
  flag: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new UsageError(`${flag} expects a whole number (got "${value}")`);
  }
  return Number(value);
}

function positiveInt(
  value: string | undefined,
  flag: string,
  fallback: number,
): number {
  const n = wholeNumber(value, flag, fallback);
  if (n < 1) throw new UsageError(`${flag} must be at least 1`);
  return n;
}

/** `x,y,width,height` in screenshot pixels. */
export function parseBox(text: string): Box {
  const parts = text.split(",").map((p) => p.trim());
  const nums = parts.map(Number);
  const [x, y, width, height] = nums;
  if (
    parts.length !== 4 ||
    parts.some((p) => p === "") ||
    nums.some((n) => !Number.isFinite(n)) ||
    x! < 0 ||
    y! < 0 ||
    width! <= 0 ||
    height! <= 0
  ) {
    throw new UsageError(
      `--ignore expects x,y,width,height with x, y ≥ 0 and width, height > 0 (got "${text}")`,
    );
  }
  return { x: x!, y: y!, width: width!, height: height! };
}
