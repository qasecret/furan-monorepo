import type { RunStatus } from "@furan/shared-types";
import { describe, expect, test } from "vitest";

import { runCompletedBlockKit } from "../src/slack/block-kit.js";

function baseOpts() {
  return {
    runId: "run-1",
    projectId: "proj-1",
    status: "passed" as RunStatus,
    diffPercent: 0,
    branchName: "main",
    severityCounts: { breaking: 0, major: 0, minor: 0, cosmetic: 0 },
    dashboardUrl: "https://app.furan.dev/projects/proj-1/runs/run-1",
  };
}

/** Spec §3.4 — emoji + GitHub-state derived attachment colour per status. */
const STATUS_TABLE: Array<{
  status: RunStatus;
  emoji: string;
  color: string;
}> = [
  { status: "running", emoji: "🔵", color: "#3b82f6" },
  { status: "new", emoji: "⚪", color: "#22c55e" },
  { status: "passed", emoji: "🟢", color: "#22c55e" },
  { status: "unresolved", emoji: "🟡", color: "#ef4444" },
  { status: "failed", emoji: "🔴", color: "#ef4444" },
  { status: "aborted", emoji: "⚠️", color: "#eab308" },
  { status: "empty", emoji: "⚪", color: "#ef4444" },
];

describe("runCompletedBlockKit", () => {
  test("emits four blocks in the canonical order: section/section/section/actions", () => {
    const payload = runCompletedBlockKit(baseOpts());
    expect(payload.blocks).toHaveLength(4);
    const types = (payload.blocks as { type: string }[]).map((b) => b.type);
    expect(types).toEqual(["section", "section", "section", "actions"]);
  });

  for (const { status, emoji, color } of STATUS_TABLE) {
    test(`status=${status} renders ${emoji} emoji and ${color} attachment colour`, () => {
      const payload = runCompletedBlockKit({ ...baseOpts(), status });
      const second = payload.blocks[1] as {
        fields: Array<{ text: string }>;
      };
      expect(second.fields[0].text).toContain(emoji);
      expect(payload.attachments?.[0]?.color).toBe(color);
    });
  }

  test("renders diffPercent with 2 decimals and a percent sign", () => {
    const payload = runCompletedBlockKit({
      ...baseOpts(),
      diffPercent: 12.3456,
    });
    const second = payload.blocks[1] as {
      fields: Array<{ text: string }>;
    };
    expect(second.fields[1].text).toContain("12.35%");
  });

  test("renders em-dash when diffPercent is null", () => {
    const payload = runCompletedBlockKit({ ...baseOpts(), diffPercent: null });
    const second = payload.blocks[1] as {
      fields: Array<{ text: string }>;
    };
    expect(second.fields[1].text).toContain("—");
  });

  test("severity-counts block renders all four coloured-dot emojis", () => {
    const payload = runCompletedBlockKit({
      ...baseOpts(),
      severityCounts: { breaking: 3, major: 2, minor: 1, cosmetic: 4 },
    });
    const third = payload.blocks[2] as { text: { text: string } };
    expect(third.text.text).toContain(":red_circle: 3");
    expect(third.text.text).toContain(":large_orange_circle: 2");
    expect(third.text.text).toContain(":large_yellow_circle: 1");
    expect(third.text.text).toContain(":large_blue_circle: 4");
  });

  test("actions block contains exactly one button pointing at dashboardUrl", () => {
    const url = "https://example.com/dash";
    const payload = runCompletedBlockKit({ ...baseOpts(), dashboardUrl: url });
    const actions = payload.blocks[3] as {
      elements: Array<{ type: string; url: string; text: { text: string } }>;
    };
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements[0].type).toBe("button");
    expect(actions.elements[0].url).toBe(url);
    expect(actions.elements[0].text.text).toBe("View in dashboard");
  });

  test("header section references the branch name", () => {
    const payload = runCompletedBlockKit({
      ...baseOpts(),
      branchName: "feature/abc",
    });
    const header = payload.blocks[0] as { text: { text: string } };
    expect(header.text.text).toContain("feature/abc");
    expect(header.text.text).toContain("Furan visual regression");
  });

  test("status field contains the spec description text", () => {
    const payload = runCompletedBlockKit({ ...baseOpts(), status: "passed" });
    const second = payload.blocks[1] as {
      fields: Array<{ text: string }>;
    };
    expect(second.fields[0].text).toContain("Furan: no visual changes");
  });
});
