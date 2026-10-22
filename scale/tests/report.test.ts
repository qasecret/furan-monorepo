import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUDGETS,
  evaluate,
  type Measurement,
  type Row,
} from "../src/budgets.js";
import { writeReport } from "../src/report.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "furan-scale-report-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const meta = {
  shape: "large" as const,
  suites: ["pipeline", "server"] as Array<"pipeline" | "server" | "browser">,
  commit: "0123456789abcdef0123456789abcdef01234567",
};

const sample = (): Row[] => {
  const measurements: Measurement[] = [
    { id: "P1", value: 1 },
    { id: "P2", value: 7421.5, note: "p95 over 50 steps" },
    { id: "R1-solo.worst", value: 61.234 },
    { id: "R7", value: null, error: "approve | threw" },
  ];
  return evaluate(BUDGETS, measurements, meta.suites);
};

describe("writeReport", () => {
  it("writes scale-report.md and scale-report.json and returns their paths", async () => {
    const out = writeReport(sample(), meta, dir);
    expect(out.md).toBe(join(dir, "scale-report.md"));
    expect(out.json).toBe(join(dir, "scale-report.json"));
    await expect(readFile(out.md, "utf8")).resolves.toContain("Id");
    await expect(readFile(out.json, "utf8")).resolves.toContain("rows");
  });

  it("creates the output directory when it does not exist", async () => {
    const nested = join(dir, "a", "b");
    const out = writeReport(sample(), meta, nested);
    await expect(readFile(out.md, "utf8")).resolves.toContain("Verdict");
  });

  it("renders the header: machine, node, commit, shape and suites", async () => {
    const md = await readFile(writeReport(sample(), meta, dir).md, "utf8");
    expect(md).toContain(meta.commit);
    expect(md).toContain(process.version);
    expect(md).toMatch(/Shape:\s*large/);
    expect(md).toMatch(/Suites:\s*pipeline, server/);
    expect(md).toMatch(/Machine:.*\d+ CPUs?.*GiB/);
  });

  it("asks git for the commit when none is given", async () => {
    const md = await readFile(
      writeReport(sample(), { shape: "smoke", suites: [] }, dir).md,
      "utf8",
    );
    // A checkout answers with its sha; a source tarball falls back to "unknown".
    expect(md).toMatch(/Commit:\s*(unknown|[0-9a-f]{40})\b/);
    expect(md).toMatch(/Suites:\s*none/);
  });

  it("falls back to 'unknown' when git cannot answer", async () => {
    vi.stubEnv("GIT_DIR", join(dir, "no-such-git-dir"));
    try {
      const out = writeReport(sample(), { shape: "smoke", suites: [] }, dir);
      expect(await readFile(out.md, "utf8")).toMatch(/Commit:\s*unknown\n/);
      const parsed = JSON.parse(await readFile(out.json, "utf8")) as {
        meta: { commit: string };
      };
      expect(parsed.meta.commit).toBe("unknown");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("renders the table columns", async () => {
    const md = await readFile(writeReport(sample(), meta, dir).md, "utf8");
    expect(md).toContain(
      "| Id | Budget | Measured | Unit | Status | Verdict | Owner |",
    );
  });

  it("renders tracked failures with their owner", async () => {
    const md = await readFile(writeReport(sample(), meta, dir).md, "utf8");
    // P2 is tracked, owner slice 2, measured 7421.5 > 5000.
    const p2 = md.split("\n").find((l) => l.startsWith("| P2 "));
    expect(p2).toBeDefined();
    expect(p2).toContain("fail (tracked, owner slice 2)");
    expect(p2).toContain("<= 5000");
    expect(p2).toContain("7421.5");
    // P1 passes plainly.
    const p1 = md.split("\n").find((l) => l.startsWith("| P1 "));
    expect(p1).toMatch(/\| pass \|/);
    expect(p1).not.toContain("tracked, owner");
  });

  it("renders an enforced failure as a plain fail", async () => {
    // No budget is enforced yet (Ruling R49): enforce one as a slice would.
    const enforced = BUDGETS.map((b) =>
      b.id === "R1-solo.worst" ? { ...b, status: "enforced" as const } : b,
    );
    const rows = evaluate(
      enforced,
      [{ id: "R1-solo.worst", value: 61.234 }],
      meta.suites,
    );
    const md = await readFile(writeReport(rows, meta, dir).md, "utf8");
    const row = md.split("\n").find((l) => l.startsWith("| R1-solo.worst "));
    expect(row).toMatch(/\| enforced \| fail \|/);
    expect(row).toContain("61.23");
  });

  it("renders missing values as a dash, and skipped rows as skipped", async () => {
    const md = await readFile(writeReport(sample(), meta, dir).md, "utf8");
    const p3 = md.split("\n").find((l) => l.startsWith("| P3 "));
    expect(p3).toContain("—");
    expect(p3).toContain("missing");
    const d1 = md.split("\n").find((l) => l.startsWith("| D1 "));
    expect(d1).toContain("skipped");
  });

  it("lists notes and errors below the table, escaping pipes", async () => {
    const md = await readFile(writeReport(sample(), meta, dir).md, "utf8");
    expect(md).toContain("p95 over 50 steps");
    expect(md).toContain("approve \\| threw");
    const tableEnd = md.lastIndexOf("| D5.next ");
    expect(md.indexOf("approve \\| threw")).toBeGreaterThan(tableEnd);
  });

  it("json round-trips rows", async () => {
    const rows = sample();
    const out = writeReport(rows, meta, dir);
    const parsed = JSON.parse(await readFile(out.json, "utf8")) as {
      meta: Record<string, unknown>;
      rows: Row[];
    };
    expect(parsed.rows).toEqual(rows);
    expect(parsed.meta).toMatchObject({
      shape: "large",
      suites: ["pipeline", "server"],
      commit: meta.commit,
      node: process.version,
    });
  });
});
