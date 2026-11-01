import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { FuranTimeoutError, type TestResult } from "@furan/client";
import { describe, expect, it } from "vitest";

import {
  formatJson,
  formatSummary,
  githubSummaryMarkdown,
  writeGithub,
} from "../src/report.js";
import type { UploadReport } from "../src/upload.js";

import { tree } from "./helpers.js";

const D = "https://d/projects/p";
const t = (
  over: Partial<TestResult> & Pick<TestResult, "name">,
): TestResult => ({
  runId: `r-${over.name}`,
  status: "passed",
  serverStatus: "passed",
  steps: ["s"],
  url: `${D}/runs/r-${over.name}`,
  ...over,
});

const report: UploadReport = {
  buildId: "b1",
  buildUrl: `${D}/builds/b1`,
  branch: "feature/x",
  timeoutSeconds: 120,
  exitCode: 1,
  tests: [
    t({ name: "login.cy.ts", steps: ["login.cy.ts/a", "login.cy.ts/b"] }),
    t({ name: "cart.cy.ts", status: "failed", serverStatus: "unresolved" }),
    t({ name: "signup", status: "new", serverStatus: "new" }),
  ],
};

describe("formatSummary", () => {
  it("summary lines and the needs-review count", () => {
    expect(formatSummary(report, false)).toBe(
      [
        `furan: 3 tests, 4 steps on feature/x  ${D}/builds/b1`,
        "  ✓ passed      login.cy.ts  2 steps",
        `  ✗ unresolved  cart.cy.ts   1 step   ${D}/runs/r-cart.cy.ts`,
        `  ! new         signup       1 step   no baseline yet: approve it in the dashboard  ${D}/runs/r-signup`,
        "furan: 1 test needs review",
      ].join("\n"),
    );
  });

  it("failOnNew counts a new test as needing review", () => {
    expect(formatSummary(report, true).split("\n").at(-1)).toBe(
      "furan: 2 tests need review",
    );
  });

  it("all passed, with new tests noted", () => {
    const ok: UploadReport = {
      ...report,
      exitCode: 0,
      tests: [
        t({ name: "a" }),
        t({ name: "b", status: "new", serverStatus: "new" }),
      ],
    };
    expect(formatSummary(ok, false).split("\n").at(-1)).toBe(
      "furan: all 2 tests passed; 1 new, waiting for a first approval",
    );
  });

  it("timeout lists the test and suggests --timeout", () => {
    const late: UploadReport = {
      ...report,
      exitCode: 3,
      tests: [
        t({
          name: "slow",
          status: "error",
          serverStatus: null,
          error: new FuranTimeoutError("r-slow", "running", 120_000),
        }),
      ],
    };
    const out = formatSummary(late, false);
    expect(out).toContain("? no verdict  slow");
    expect(out).toContain("(raise --timeout, now 120s)");
    expect(out.split("\n").at(-1)).toBe("furan: 1 test had no verdict");
  });

  it("no dashboard url names the batch id; --no-wait says so", () => {
    const uploaded: UploadReport = {
      ...report,
      buildUrl: null,
      exitCode: 0,
      tests: [
        t({ name: "a", status: "uploaded", serverStatus: null, url: null }),
      ],
    };
    const lines = formatSummary(uploaded, false).split("\n");
    expect(lines[0]).toBe("furan: 1 test, 1 step on feature/x  (batch b1)");
    expect(lines[1]).toBe("  ✓ uploaded    a  1 step");
    expect(lines.at(-1)).toBe(
      "furan: uploaded 1 test; not waiting for verdicts (--no-wait)",
    );
  });
});

describe("formatJson", () => {
  it("json output is stable", () => {
    const parsed = JSON.parse(formatJson(report)) as Record<string, unknown>;
    expect(parsed).toEqual({
      buildId: "b1",
      buildUrl: `${D}/builds/b1`,
      branch: "feature/x",
      exitCode: 1,
      tests: report.tests.map((r) => ({
        name: r.name,
        runId: r.runId,
        status: r.status,
        serverStatus: r.serverStatus,
        steps: r.steps,
        url: r.url,
      })),
    });
  });

  it("an error is reported by its message", () => {
    const parsed = JSON.parse(
      formatJson({
        ...report,
        tests: [t({ name: "x", status: "error", error: new Error("boom") })],
      }),
    ) as { tests: Array<{ error?: string }> };
    expect(parsed.tests[0]!.error).toBe("boom");
  });
});

describe("GitHub output", () => {
  it("github markdown has a row per test with links", () => {
    const md = githubSummaryMarkdown(report);
    expect(md).toContain(`[batch](${D}/builds/b1)`);
    expect(md).toContain(
      `| ✗ | cart.cy.ts | unresolved | 1 | [review](${D}/runs/r-cart.cy.ts) |`,
    );
    expect(md).toContain("| ✓ | login.cy.ts | passed | 2 |");
    expect(md.split("\n").filter((l) => l.startsWith("| ")).length).toBe(4);
  });

  it("escapes a | in a test name", () => {
    expect(
      githubSummaryMarkdown({ ...report, tests: [t({ name: "a|b" })] }),
    ).toContain("| a\\|b |");
  });

  it("writeGithub appends summary and outputs", async () => {
    const dir = await tree({ "summary.md": "before\n", "output.txt": "" });
    const env = {
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      GITHUB_OUTPUT: join(dir, "output.txt"),
    };
    await writeGithub(report, false, env);
    const summary = await readFile(env.GITHUB_STEP_SUMMARY, "utf8");
    expect(summary.startsWith("before\n")).toBe(true);
    expect(summary).toContain("cart.cy.ts");
    const output = await readFile(env.GITHUB_OUTPUT, "utf8");
    expect(output).toBe(
      `build-id=b1\nbuild-url=${D}/builds/b1\nstatus=failed\n`,
    );
  });

  it("writeGithub is a no-op without the env vars", async () => {
    await expect(writeGithub(report, false, {})).resolves.toBeUndefined();
  });
});
