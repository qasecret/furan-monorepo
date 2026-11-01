import { appendFile } from "node:fs/promises";

import {
  FuranTimeoutError,
  isPassing,
  type ResultStatus,
  type TestResult,
} from "@furan/client";

import { overallStatus, type UploadReport } from "./upload.js";

const ICONS: Record<ResultStatus, string> = {
  passed: "✓",
  uploaded: "✓",
  skipped: "✓",
  failed: "✗",
  new: "!",
  error: "?",
};

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/** The column word for a result: the server's status for a failure. */
function label(r: TestResult): string {
  if (r.status === "failed") return r.serverStatus ?? "failed";
  if (r.status === "error") return "no verdict";
  return r.status;
}

function tail(r: TestResult, timeoutSeconds: number): string {
  switch (r.status) {
    case "failed":
      return r.url ?? "";
    case "new":
      return (
        "no baseline yet: approve it in the dashboard" +
        (r.url ? `  ${r.url}` : "")
      );
    case "error":
      return (
        (r.error?.message ?? "no verdict") +
        (r.error instanceof FuranTimeoutError
          ? ` (raise --timeout, now ${timeoutSeconds}s)`
          : "")
      );
    default:
      return "";
  }
}

/** The human summary printed on stdout (spec §5.4). */
export function formatSummary(
  report: UploadReport,
  failOnNew: boolean,
): string {
  const { tests } = report;
  const steps = tests.reduce((n, t) => n + t.steps.length, 0);
  const where = report.buildUrl ?? `(batch ${report.buildId})`;
  const lines = [
    `furan: ${plural(tests.length, "test")}, ${plural(steps, "step")} on ${report.branch}  ${where}`,
  ];
  const width = Math.max(0, ...tests.map((t) => t.name.length));
  for (const t of tests) {
    const end = tail(t, report.timeoutSeconds);
    lines.push(
      `  ${ICONS[t.status]} ${label(t).padEnd(10)}  ${t.name.padEnd(width)}  ${plural(t.steps.length, "step").padEnd(7)}${end ? `  ${end}` : ""}`.trimEnd(),
    );
  }

  const review = tests.filter(
    (t) => t.status !== "error" && !isPassing(t.status, failOnNew),
  ).length;
  const errors = tests.filter((t) => t.status === "error").length;
  const fresh = tests.filter((t) => t.status === "new" && !failOnNew).length;
  const parts: string[] = [];
  if (review > 0) {
    parts.push(
      `${plural(review, "test")} need${review === 1 ? "s" : ""} review`,
    );
  }
  if (errors > 0) parts.push(`${plural(errors, "test")} had no verdict`);
  if (parts.length === 0) {
    if (tests.length > 0 && tests.every((t) => t.status === "uploaded")) {
      parts.push(
        `uploaded ${plural(tests.length, "test")}; not waiting for verdicts (--no-wait)`,
      );
    } else {
      parts.push(
        (tests.length === 1
          ? "the test passed"
          : `all ${tests.length} tests passed`) +
          (fresh > 0 ? `; ${fresh} new, waiting for a first approval` : ""),
      );
    }
  }
  lines.push(`furan: ${parts.join(", ")}`);
  return lines.join("\n");
}

/** `--json`: the machine-readable result. */
export function formatJson(report: UploadReport): string {
  return JSON.stringify(
    {
      buildId: report.buildId,
      buildUrl: report.buildUrl,
      branch: report.branch,
      tests: report.tests.map((t) => ({
        name: t.name,
        runId: t.runId,
        status: t.status,
        serverStatus: t.serverStatus,
        steps: t.steps,
        url: t.url,
        ...(t.error ? { error: t.error.message } : {}),
      })),
      exitCode: report.exitCode,
    },
    null,
    2,
  );
}

const cell = (text: string): string => text.replace(/\|/g, "\\|");

/** A Markdown results table for the GitHub job summary. */
export function githubSummaryMarkdown(report: UploadReport): string {
  const steps = report.tests.reduce((n, t) => n + t.steps.length, 0);
  const batch = report.buildUrl
    ? `[batch](${report.buildUrl})`
    : `batch \`${report.buildId}\``;
  const rows = report.tests.map((t) => {
    const link =
      t.url && ["failed", "new", "error"].includes(t.status)
        ? `[review](${t.url})`
        : "";
    return `| ${ICONS[t.status]} | ${cell(t.name)} | ${cell(label(t))} | ${t.steps.length} | ${link} |`;
  });
  return [
    "### Furan visual tests",
    "",
    `${batch} on \`${report.branch}\`: ${plural(report.tests.length, "test")}, ${plural(steps, "step")}`,
    "",
    "| | Test | Status | Steps | Review |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/**
 * On GitHub Actions: append the summary to `GITHUB_STEP_SUMMARY` and the
 * `build-id`, `build-url` and `status` outputs to `GITHUB_OUTPUT`.
 */
export async function writeGithub(
  report: UploadReport,
  failOnNew: boolean,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, githubSummaryMarkdown(report));
  }
  if (env.GITHUB_OUTPUT) {
    await appendFile(
      env.GITHUB_OUTPUT,
      `build-id=${report.buildId}\nbuild-url=${report.buildUrl ?? ""}\nstatus=${overallStatus(report.tests, failOnNew)}\n`,
    );
  }
}
