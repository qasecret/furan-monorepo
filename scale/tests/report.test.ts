import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    { id: "P4", value: 0.41 },
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
      const md = await readFile(out.md, "utf8");
      expect(md).toMatch(/Commit:\s*unknown\n/);
      expect(md).toMatch(/Working tree:\s*unknown\n/);
      const parsed = JSON.parse(await readFile(out.json, "utf8")) as {
        meta: { commit: string; dirty: boolean | null };
      };
      expect(parsed.meta.commit).toBe("unknown");
      expect(parsed.meta.dirty).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("says whether the working tree was dirty, in the markdown and the JSON", async () => {
    const dirty = writeReport(sample(), { ...meta, dirty: true }, dir);
    expect(await readFile(dirty.md, "utf8")).toMatch(
      /- Working tree: dirty \(uncommitted changes/,
    );
    expect(
      (JSON.parse(await readFile(dirty.json, "utf8")) as { meta: object }).meta,
    ).toMatchObject({ dirty: true });

    const clean = writeReport(sample(), { ...meta, dirty: false }, dir);
    expect(await readFile(clean.md, "utf8")).toMatch(/- Working tree: clean\n/);
    expect(
      (JSON.parse(await readFile(clean.json, "utf8")) as { meta: object }).meta,
    ).toMatchObject({ dirty: false });
  });

  it("asks git whether the tree is dirty, untracked files included", async () => {
    // A throwaway repository, named to git through its environment.
    const repo = join(dir, "repo");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    await mkdir(repo);
    git("init", "-q");
    git("config", "user.email", "scale@example.invalid");
    git("config", "user.name", "scale");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "a");
    vi.stubEnv("GIT_DIR", join(repo, ".git"));
    vi.stubEnv("GIT_WORK_TREE", repo);
    const out = join(dir, "out");
    const tree = async () =>
      (
        JSON.parse(
          await readFile(
            writeReport(sample(), { shape: "smoke", suites: [] }, out).json,
            "utf8",
          ),
        ) as { meta: { dirty: boolean | null } }
      ).meta.dirty;
    try {
      expect(await tree()).toBe(false);
      await writeFile(join(repo, "a.txt"), "edited\n");
      expect(await tree()).toBe(true);
      git("checkout", "--", "a.txt");
      expect(await tree()).toBe(false);
      await writeFile(join(repo, "new.txt"), "untracked\n");
      expect(await tree()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lists each suite's start and end, and the quiesce after it, in the header", async () => {
    const timeline = [
      {
        suite: "browser" as const,
        startedAt: "2026-10-22T01:05:00.000Z",
        endedAt: "2026-10-22T01:13:02.500Z",
        seconds: 482.5,
        quiesce: "quiesce after browser: drained in 0.2s",
      },
      {
        suite: "server" as const,
        startedAt: "2026-10-22T01:13:03.000Z",
        endedAt: "2026-10-22T01:23:00.000Z",
        seconds: 597,
      },
    ];
    const out = writeReport(sample(), { ...meta, timeline }, dir);
    const md = await readFile(out.md, "utf8");
    const header = md.slice(0, md.indexOf("| Id |"));
    expect(header).toContain(
      [
        "- Timeline:",
        "  - browser: 2026-10-22T01:05:00.000Z to 2026-10-22T01:13:02.500Z (482.5 s)",
        "  - quiesce after browser: drained in 0.2s",
        "  - server: 2026-10-22T01:13:03.000Z to 2026-10-22T01:23:00.000Z (597.0 s)",
      ].join("\n"),
    );
    const parsed = JSON.parse(await readFile(out.json, "utf8")) as {
      meta: { timeline: unknown };
    };
    expect(parsed.meta.timeline).toEqual(timeline);

    // No suite ran: no timeline.
    const none = await readFile(writeReport(sample(), meta, dir).md, "utf8");
    expect(none).not.toContain("Timeline");
  });

  it("renders the table columns", async () => {
    const md = await readFile(writeReport(sample(), meta, dir).md, "utf8");
    expect(md).toContain(
      "| Id | Budget | Measured | Unit | Status | Verdict | Owner |",
    );
  });

  it("renders tracked failures with their owner", async () => {
    const md = await readFile(writeReport(sample(), meta, dir).md, "utf8");
    // P4 is tracked, owner slice 2, measured 0.41 < 0.8.
    const p4 = md.split("\n").find((l) => l.startsWith("| P4 "));
    expect(p4).toBeDefined();
    expect(p4).toContain("fail (tracked, owner slice 2)");
    expect(p4).toContain(">= 0.8");
    expect(p4).toContain("0.41");
    // P1 passes plainly.
    const p1 = md.split("\n").find((l) => l.startsWith("| P1 "));
    expect(p1).toMatch(/\| pass \|/);
    expect(p1).not.toContain("tracked, owner");
  });

  it("renders an enforced failure as a plain fail", async () => {
    // R1-solo.worst is tracked today: enforce it as an owning slice would.
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
