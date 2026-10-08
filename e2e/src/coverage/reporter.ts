import { writeFileSync } from "node:fs";

import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import { CAPABILITIES } from "./manifest.js";

/**
 * Build Playwright annotations that tag a test with the capability IDs it
 * covers. Usage inside a test:
 *   testInfo.annotations.push(...coverAnnotations(["diff.engine.odiff"]));
 */
export function coverAnnotations(
  ids: string[],
): { type: string; description: string }[] {
  return ids.map((id) => ({ type: "cap", description: id }));
}

type State = "passed" | "failed" | "config-gated" | "MISSING";

/**
 * Custom reporter: reads the `cap` annotations off each test, records the worst
 * outcome per capability, and writes `e2e-coverage.{md,json}` — the measured
 * coverage deliverable.
 */
export default class CoverageReporter implements Reporter {
  private readonly status = new Map<string, "passed" | "failed">();

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const a of test.annotations) {
      if (a.type === "cap" && a.description) {
        const now: "passed" | "failed" =
          result.status === "passed" ? "passed" : "failed";
        const prev = this.status.get(a.description);
        // failed is sticky — one failing test fails the capability
        this.status.set(a.description, prev === "failed" ? "failed" : now);
      }
    }
  }

  onEnd(_result: FullResult): void {
    const rows = CAPABILITIES.map((c) => {
      const observed = this.status.get(c.id);
      const state: State = observed
        ? observed
        : c.configGated
          ? "config-gated"
          : "MISSING";
      return { area: c.area, id: c.id, label: c.label, state };
    });

    writeFileSync("e2e-coverage.json", JSON.stringify(rows, null, 2));

    const covered = rows.filter((r) => r.state === "passed").length;
    const gated = rows.filter((r) => r.state === "config-gated").length;
    const missing = rows.filter((r) => r.state === "MISSING").length;
    const failed = rows.filter((r) => r.state === "failed").length;

    const md = [
      "# E2E capability coverage",
      "",
      `passed **${covered}** · failed **${failed}** · config-gated **${gated}** · missing **${missing}** · total **${rows.length}**`,
      "",
      "| area | capability | id | state |",
      "| --- | --- | --- | --- |",
      ...rows.map(
        (r) => `| ${r.area} | ${r.label} | \`${r.id}\` | ${r.state} |`,
      ),
    ].join("\n");

    writeFileSync("e2e-coverage.md", md);
    // eslint-disable-next-line no-console
    console.log(
      `\n[coverage] passed=${covered} failed=${failed} gated=${gated} missing=${missing} → e2e-coverage.md`,
    );
  }
}
