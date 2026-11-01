import { promises as fsp } from "node:fs";

import {
  Furan,
  FuranApiError,
  FuranConfigError,
  FuranInputError,
  maskToken,
  resolveConfig,
  type FuranOptions,
} from "@furan/client";

import { parseArgs, UsageError, type UploadArgs } from "./args.js";
import { formatJson, formatSummary, writeGithub } from "./report.js";
import { planUpload, type PlannedTest } from "./scan.js";
import { runUpload } from "./upload.js";
import { VERSION } from "./version.js";

export interface MainDeps {
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  createFuran?: (options: FuranOptions, env: NodeJS.ProcessEnv) => Furan;
  signal?: AbortSignal;
}

const HELP = `furan ${VERSION} — send PNG screenshots to Furan and get a verdict

Usage:
  furan upload <file.png | folder>… [options]

Each folder's PNGs become steps; a file's folder (relative to the path you
pass) becomes its test, so cypress/screenshots/login.cy.ts/form.png is step
"login.cy.ts/form" of test "login.cy.ts". A cart.furan.json next to cart.png
may carry that step's regions and match level.

Options:
  --test <name>            put every step into one test
  --ignore x,y,w,h         ignore region for every step (repeatable)
  --match-level <level>    Strict, Layout, Content, IgnoreColors or Dynamic
  --browser, --os, --device <label>   environment labels (baseline identity)
  --viewport WxH           viewport label (default: each PNG's size)
  --branch, --parent-branch, --build-name, --ci-build-id <value>
  --save-new-tests         approve first baselines automatically
  --fail-on-new            fail when a step has no baseline yet
  --no-wait                upload and complete; don't wait for verdicts
  --timeout <seconds>      verdict wait budget (default 120)
  --concurrency <n>        parallel requests (default 4, max 16)
  --json                   print the result as JSON
  --dry-run                show the config and the plan; send nothing
  -h, --help / -v, --version

Environment: FURAN_API_URL, FURAN_API_TOKEN and FURAN_PROJECT_ID are required;
see https://github.com/qasecret/furan-monorepo/blob/main/docs/integrations/javascript.md

Exit codes: 0 passed, 1 needs review, 2 bad input or config, 3 no verdict.`;

/** Run the CLI; resolves to the process exit code. */
export async function main(argv: string[], deps: MainDeps): Promise<number> {
  let args: UploadArgs;
  try {
    const parsed = parseArgs(argv);
    if (parsed.kind === "help") {
      deps.stdout(HELP);
      return 0;
    }
    if (parsed.kind === "version") {
      deps.stdout(VERSION);
      return 0;
    }
    args = parsed.args;
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr(`furan: ${err.message}\nRun "furan --help" for usage.`);
      return 2;
    }
    throw err;
  }

  try {
    const plan = await planUpload(args.paths, {
      test: args.test,
      viewport: args.viewport,
    });
    const options = toOptions(args);
    if (args.dryRun) {
      deps.stdout(dryRun(plan, options, deps.env));
      return 0;
    }
    const createFuran = deps.createFuran ?? ((o, env) => Furan.fromEnv(o, env));
    const furan = createFuran(options, deps.env);
    const report = await runUpload(plan, args, {
      furan,
      readFile: async (path) => new Uint8Array(await fsp.readFile(path)),
      log: deps.stderr,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    deps.stdout(
      args.json
        ? formatJson(report)
        : formatSummary(report, furan.config.failOnNew),
    );
    await writeGithub(report, furan.config.failOnNew, deps.env);
    return report.exitCode;
  } catch (err) {
    if (deps.signal?.aborted) {
      deps.stderr("furan: interrupted; tests still open were aborted");
      return 130;
    }
    if (
      err instanceof FuranConfigError ||
      err instanceof FuranInputError ||
      err instanceof UsageError
    ) {
      deps.stderr(`furan: ${err.message}`);
      return 2;
    }
    if (err instanceof FuranApiError) {
      deps.stderr(`furan: ${err.message}`);
      return 3;
    }
    deps.stderr(
      `furan: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return 3;
  }
}

/** CLI flags as config options; an unset flag leaves the env value in charge. */
function toOptions(args: UploadArgs): FuranOptions {
  const options: FuranOptions = {};
  if (args.branch) options.branch = args.branch;
  if (args.parentBranch) options.parentBranch = args.parentBranch;
  if (args.buildName) options.buildName = args.buildName;
  if (args.ciBuildId) options.ciBuildId = args.ciBuildId;
  if (args.browser) options.browser = args.browser;
  if (args.os) options.os = args.os;
  if (args.device) options.device = args.device;
  if (args.saveNewTests) options.saveNewTests = true;
  if (args.failOnNew) options.failOnNew = true;
  if (args.timeoutSeconds !== null)
    options.timeoutMs = args.timeoutSeconds * 1000;
  return options;
}

function dryRun(
  plan: PlannedTest[],
  options: FuranOptions,
  env: NodeJS.ProcessEnv,
): string {
  const c = resolveConfig(options, env);
  const build =
    c.buildId !== null
      ? `existing build ${c.buildId}`
      : c.ciBuildId !== null
        ? `find or create by ciBuildId ${c.ciBuildId}`
        : "a new build";
  const lines = [
    "furan: dry run; nothing is sent",
    `  api:      ${c.apiUrl}`,
    `  token:    ${maskToken(c.token)}`,
    `  project:  ${c.projectId}`,
    `  branch:   ${c.branch}${c.parentBranch ? ` (parent ${c.parentBranch})` : ""}`,
    `  build:    ${build}${c.buildName ? `, named "${c.buildName}"` : ""}`,
    `  labels:   browser ${c.browser ?? "image"}, os ${c.os ?? "-"}, device ${c.device ?? "-"}`,
    `  verdict:  wait ${c.timeoutMs / 1000}s, save new tests ${c.saveNewTests ? "on" : "off"}, fail on new ${c.failOnNew ? "on" : "off"}`,
    "plan:",
  ];
  for (const t of plan) {
    lines.push(
      `  test ${t.name} (${t.steps.length} step${t.steps.length === 1 ? "" : "s"})`,
    );
    for (const s of t.steps) {
      lines.push(
        `    ${s.name}  ${s.file}  ${s.width}x${s.height}${s.sidecar ? "  +sidecar" : ""}`,
      );
    }
  }
  return lines.join("\n");
}
