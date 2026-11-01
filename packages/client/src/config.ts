import { detectCi, gitBranch as defaultGitBranch } from "./ci.js";
import { FuranConfigError } from "./errors.js";

/** Everything the client needs, resolved (spec §4.2). */
export interface FuranConfig {
  apiUrl: string;
  token: string;
  projectId: string;
  /** Attach to this existing build (a Furan build id) instead of creating one. */
  buildId: string | null;
  /** The pipeline key: every job with the same one joins one build. */
  ciBuildId: string | null;
  branch: string;
  parentBranch: string | null;
  buildName: string | null;
  buildNumber: number | null;
  properties: Record<string, string>;
  browser: string | null;
  os: string | null;
  device: string | null;
  saveNewTests: boolean;
  failOnNew: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  dashboardUrl: string | null;
}

/** Explicit settings; an undefined value counts as unset. */
export type FuranOptions = {
  [K in keyof FuranConfig]?: FuranConfig[K] | undefined;
};

export interface ConfigDeps {
  gitBranch?: () => string | null;
  warn?: (msg: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROPERTY_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;
const MAX_PROPERTIES = 20;
const MAX_NAME = 200;

const defaultWarn = (msg: string): void => {
  process.stderr.write(`furan: ${msg}\n`);
};

/** Merge options, FURAN_* env, the CI environment and defaults, then validate. */
export function resolveConfig(
  options: FuranOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  deps: ConfigDeps = {},
): FuranConfig {
  const warn = deps.warn ?? defaultWarn;
  const e = (key: string): string | null => {
    const value = env[key]?.trim();
    return value ? value : null;
  };
  const ci = detectCi(env);

  const apiUrl = required(
    options.apiUrl ?? e("FURAN_API_URL"),
    "FURAN_API_URL",
  );
  if (!/^https?:\/\/[^/]/i.test(apiUrl) || !URL.canParse(apiUrl)) {
    throw new FuranConfigError(
      "FURAN_API_URL",
      `FURAN_API_URL must be an http(s) URL of the Furan api, e.g. http://localhost:8080/api (got "${apiUrl}")`,
    );
  }
  const token = required(
    options.token ?? e("FURAN_API_TOKEN"),
    "FURAN_API_TOKEN",
  );
  const projectId = required(
    options.projectId ?? e("FURAN_PROJECT_ID"),
    "FURAN_PROJECT_ID",
  );
  if (!UUID.test(projectId)) {
    throw new FuranConfigError(
      "FURAN_PROJECT_ID",
      "FURAN_PROJECT_ID must be the project's id (a UUID, shown in the project's settings)",
    );
  }

  const buildId = options.buildId ?? e("FURAN_BUILD_ID");
  if (buildId !== null && !UUID.test(buildId)) {
    throw new FuranConfigError(
      "FURAN_BUILD_ID",
      "FURAN_BUILD_ID must be a Furan build id (a UUID); to group the jobs of a CI pipeline into one build, set FURAN_CI_BUILD_ID instead",
    );
  }

  const ciBuildId =
    options.ciBuildId ?? e("FURAN_CI_BUILD_ID") ?? ci?.ciBuildId ?? null;
  if (ciBuildId !== null && ciBuildId.length > MAX_NAME) {
    throw new FuranConfigError(
      "FURAN_CI_BUILD_ID",
      `FURAN_CI_BUILD_ID must be at most ${MAX_NAME} characters`,
    );
  }

  const branch =
    options.branch ??
    e("FURAN_BRANCH") ??
    ci?.branch ??
    (deps.gitBranch ?? defaultGitBranch)() ??
    "main";
  if (branch.length > MAX_NAME) {
    throw new FuranConfigError(
      "FURAN_BRANCH",
      `FURAN_BRANCH must be at most ${MAX_NAME} characters`,
    );
  }

  const buildName =
    options.buildName ?? e("FURAN_BUILD_NAME") ?? ci?.buildName ?? null;

  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    token,
    projectId,
    buildId,
    ciBuildId,
    branch,
    parentBranch:
      options.parentBranch ??
      e("FURAN_PARENT_BRANCH") ??
      ci?.parentBranch ??
      null,
    buildName: buildName === null ? null : buildName.slice(0, MAX_NAME),
    buildNumber: options.buildNumber ?? ci?.buildNumber ?? null,
    properties:
      options.properties ??
      parseProperties(e("FURAN_BUILD_PROPERTIES") ?? undefined, warn),
    browser: options.browser ?? e("FURAN_BROWSER"),
    os: options.os ?? e("FURAN_OS"),
    device: options.device ?? e("FURAN_DEVICE"),
    saveNewTests: options.saveNewTests ?? truthy(e("FURAN_SAVE_NEW_TESTS")),
    failOnNew: options.failOnNew ?? truthy(e("FURAN_FAIL_ON_NEW")),
    timeoutMs: millis(
      options.timeoutMs,
      e("FURAN_POLL_TIMEOUT_SECONDS"),
      "FURAN_POLL_TIMEOUT_SECONDS",
      120_000,
    ),
    pollIntervalMs: millis(
      options.pollIntervalMs,
      e("FURAN_POLL_INTERVAL_SECONDS"),
      "FURAN_POLL_INTERVAL_SECONDS",
      2_000,
    ),
    dashboardUrl:
      (options.dashboardUrl ?? e("FURAN_DASHBOARD_URL"))?.replace(/\/+$/, "") ??
      null,
  };
}

function required(value: string | null, variable: string): string {
  if (value === null || value === "") {
    throw new FuranConfigError(variable, `${variable} is required`);
  }
  return value;
}

function truthy(value: string | null): boolean {
  return value !== null && (value === "1" || value.toLowerCase() === "true");
}

function millis(
  option: number | undefined,
  seconds: string | null,
  variable: string,
  fallback: number,
): number {
  if (option !== undefined) {
    if (!(option > 0)) {
      throw new FuranConfigError(variable, `${variable} must be positive`);
    }
    return option;
  }
  if (seconds === null) return fallback;
  if (!/^\d+$/.test(seconds) || Number(seconds) === 0) {
    throw new FuranConfigError(
      variable,
      `${variable} must be a positive whole number of seconds (got "${seconds}")`,
    );
  }
  return Number(seconds) * 1000;
}

/**
 * `key=value` pairs separated by `,` or `;`. Malformed pairs (no `=`, an empty
 * or invalid key) and keys past the api's 20 are dropped with a warning:
 * a misformatted CI variable never fails the run.
 */
export function parseProperties(
  raw: string | undefined,
  warn: (msg: string) => void = defaultWarn,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const token of raw.split(/[,;]/)) {
    const pair = token.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq).trim() : "";
    if (!PROPERTY_KEY.test(key)) {
      warn(`skipping malformed FURAN_BUILD_PROPERTIES entry '${pair}'`);
      continue;
    }
    if (Object.keys(out).length >= MAX_PROPERTIES && !(key in out)) {
      warn(
        `FURAN_BUILD_PROPERTIES has more than ${MAX_PROPERTIES} keys; dropping '${key}'`,
      );
      continue;
    }
    out[key] = pair
      .slice(eq + 1)
      .trim()
      .slice(0, 256);
  }
  return out;
}

/** A token safe to print: the `furan_pat_` prefix and the last 4 characters. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  const prefix = token.startsWith("furan_pat_") ? "furan_pat_" : "";
  return `${prefix}****${token.slice(-4)}`;
}
