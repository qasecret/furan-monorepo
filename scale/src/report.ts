import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";

import type { Row, Suite } from "./budgets.js";

export interface ReportMeta {
  shape: "large" | "smoke";
  suites: readonly Suite[];
  /** Defaults to `git rev-parse HEAD`, or "unknown" when git cannot answer. */
  commit?: string;
}

interface Machine {
  cpu: string;
  cpus: number;
  memoryGiB: number;
}

function machine(): Machine {
  const list = cpus();
  return {
    cpu: list[0]?.model ?? "unknown",
    cpus: list.length,
    memoryGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
  };
}

function gitCommit(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return sha === "" ? "unknown" : sha;
  } catch {
    return "unknown";
  }
}

const formatValue = (value: number | null): string =>
  value === null ? "—" : String(Math.round(value * 100) / 100);

/** A tracked failure names the slice that owns the fix; every other verdict is plain. */
const formatVerdict = (row: Row): string =>
  row.verdict === "fail" && row.status === "tracked"
    ? `fail (tracked, owner slice ${row.owner})`
    : row.verdict;

const cell = (text: string): string => text.replace(/\|/g, "\\|");

function renderMarkdown(
  rows: readonly Row[],
  meta: { shape: string; suites: readonly Suite[]; commit: string },
  env: Machine,
): string {
  const lines = [
    "# Scale report",
    "",
    `- Machine: ${env.cpu}, ${env.cpus} CPUs, ${env.memoryGiB} GiB memory`,
    `- Node: ${process.version}`,
    `- Commit: ${meta.commit}`,
    `- Shape: ${meta.shape}`,
    `- Suites: ${meta.suites.length > 0 ? meta.suites.join(", ") : "none"}`,
    "",
    "| Id | Budget | Measured | Unit | Status | Verdict | Owner |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${[
        cell(row.id),
        `${row.compare} ${row.threshold}`,
        formatValue(row.value),
        row.unit,
        row.status,
        formatVerdict(row),
        `slice ${row.owner}`,
      ].join(" | ")} |`,
    );
  }
  const noted = rows.filter((row) => row.note !== undefined);
  if (noted.length > 0) {
    lines.push("", "## Notes", "");
    for (const row of noted) {
      lines.push(`- ${cell(row.id)} (${row.verdict}): ${cell(row.note ?? "")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Writes `scale-report.md` and `scale-report.json` into `dir` (created if needed). */
export function writeReport(
  rows: readonly Row[],
  meta: ReportMeta,
  dir: string,
): { md: string; json: string } {
  const resolved = {
    shape: meta.shape,
    suites: [...meta.suites],
    commit: meta.commit ?? gitCommit(),
  };
  const env = machine();

  mkdirSync(dir, { recursive: true });
  const md = join(dir, "scale-report.md");
  const json = join(dir, "scale-report.json");
  writeFileSync(md, renderMarkdown(rows, resolved, env));
  writeFileSync(
    json,
    `${JSON.stringify(
      {
        meta: {
          ...resolved,
          node: process.version,
          machine: env,
          generatedAt: new Date().toISOString(),
        },
        rows,
      },
      null,
      2,
    )}\n`,
  );
  return { md, json };
}
