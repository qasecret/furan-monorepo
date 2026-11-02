import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";

import type { Row, Suite } from "./budgets.js";
import {
  LOOP_LAG_P99_METRIC,
  POOL_WAIT_METRIC,
  type SuiteLoad,
} from "./load.js";

/** One suite's run, and the quiesce after it (Ruling R48), as the CLI saw them. */
export interface SuiteRun {
  suite: Suite;
  /** ISO 8601. */
  startedAt: string;
  endedAt: string;
  seconds: number;
  /** The quiesce's line (`describeQuiesce`). */
  quiesce?: string;
  /** The pool wait and event-loop lag while the suite ran (spec §8). */
  load?: SuiteLoad;
}

export interface ReportMeta {
  shape: "large" | "smoke";
  suites: readonly Suite[];
  /** Defaults to `git rev-parse HEAD`, or "unknown" when git cannot answer. */
  commit?: string;
  /**
   * Whether the working tree had uncommitted changes (`git status
   * --porcelain` listed anything): then the numbers are not the commit's
   * alone. Defaults to asking git; null when git cannot answer.
   */
  dirty?: boolean | null;
  /** Each suite's start and end, and the quiesce after it, in run order. */
  timeline?: readonly SuiteRun[];
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

function gitDirty(): boolean | null {
  try {
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      },
    );
    return status.trim() !== "";
  } catch {
    return null;
  }
}

const formatTree = (dirty: boolean | null): string =>
  dirty === null
    ? "unknown"
    : dirty
      ? "dirty (uncommitted changes: the numbers are not the commit's alone)"
      : "clean";

const formatValue = (value: number | null): string =>
  value === null ? "—" : String(Math.round(value * 100) / 100);

/** A tracked failure names the slice that owns the fix; every other verdict is plain. */
const formatVerdict = (row: Row): string =>
  row.verdict === "fail" && row.status === "tracked"
    ? `fail (tracked, owner slice ${row.owner})`
    : row.verdict;

const cell = (text: string): string => text.replace(/\|/g, "\\|");

/**
 * The load notes (spec 2026-10-27 §8): each suite's pool wait p95 and
 * event-loop lag p99, and how to read them. Empty when no suite carried its
 * load.
 */
function renderLoad(timeline: readonly SuiteRun[]): string[] {
  const loaded = timeline.filter(
    (run): run is SuiteRun & { load: SuiteLoad } => run.load !== undefined,
  );
  if (loaded.length === 0) return [];
  const lines = [
    "",
    "## Load",
    "",
    "| Suite | Pool wait p95 (ms) | Transactions | Event-loop lag p99 (ms) |",
    "| --- | --- | --- | --- |",
  ];
  for (const { suite, load } of loaded) {
    const { p95Ms, beyondBuckets, transactions } = load.poolWait;
    const p95 =
      load.error !== undefined
        ? "—"
        : `${beyondBuckets ? "≥ " : ""}${formatValue(p95Ms)}`;
    lines.push(
      `| ${[
        suite,
        p95,
        load.error !== undefined ? "—" : String(transactions),
        formatValue(load.loopLagP99Ms),
      ].join(" | ")} |`,
    );
  }
  lines.push(
    "",
    `- Pool wait is \`${POOL_WAIT_METRIC}\`: how long each tRPC procedure that opened a request transaction waited for it (a pooled connection, then its BEGIN) while the suite ran. The p95 is estimated from the histogram's buckets, linearly within the bucket it falls in; "≥" marks one past the last bucket, a floor.`,
    "- Pool wait omits transactions that never begin, such as a connect error: a pool that cannot connect shows as fewer transactions, not as a longer wait.",
    `- Event-loop lag is \`${LOOP_LAG_P99_METRIC}\` over the suite. prom-client samples the loop every 10 ms, so an idle loop reads about 10 to 12 ms. The API, the diff worker and the harness's clients share one process, so this is the harness's loop, not the API's alone.`,
  );
  for (const { suite, load } of loaded) {
    if (load.error !== undefined) {
      lines.push(
        `- ${suite}: the load could not be read (${cell(load.error)})`,
      );
    }
  }
  return lines;
}

function renderMarkdown(
  rows: readonly Row[],
  meta: {
    shape: string;
    suites: readonly Suite[];
    commit: string;
    dirty: boolean | null;
    timeline: readonly SuiteRun[];
  },
  env: Machine,
): string {
  const lines = [
    "# Scale report",
    "",
    `- Machine: ${env.cpu}, ${env.cpus} CPUs, ${env.memoryGiB} GiB memory`,
    `- Node: ${process.version}`,
    `- Commit: ${meta.commit}`,
    `- Working tree: ${formatTree(meta.dirty)}`,
    `- Shape: ${meta.shape}`,
    `- Suites: ${meta.suites.length > 0 ? meta.suites.join(", ") : "none"}`,
    ...(meta.timeline.length > 0
      ? [
          "- Timeline:",
          ...meta.timeline.flatMap((run) => [
            `  - ${run.suite}: ${run.startedAt} to ${run.endedAt} (${run.seconds.toFixed(1)} s)`,
            ...(run.quiesce !== undefined ? [`  - ${cell(run.quiesce)}`] : []),
          ]),
        ]
      : []),
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
  lines.push(...renderLoad(meta.timeline));
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
    dirty: meta.dirty !== undefined ? meta.dirty : gitDirty(),
    timeline: [...(meta.timeline ?? [])],
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
