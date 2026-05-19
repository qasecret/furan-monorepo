import type { RunStatus } from "@furan/shared-types";
import { describe, expect, test } from "vitest";

import { buildPayload, isSlackUrl } from "../src/slack/notifier.js";

describe("isSlackUrl", () => {
  test("returns true for Slack incoming-webhook URLs", () => {
    expect(
      isSlackUrl(
        "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX",
      ),
    ).toBe(true);
  });

  test("returns false for other URLs", () => {
    expect(isSlackUrl("https://example.com/webhook")).toBe(false);
    expect(isSlackUrl("https://discord.com/api/webhooks/x/y")).toBe(false);
    expect(isSlackUrl("http://hooks.slack.com/x")).toBe(false); // http, not https
  });
});

describe("buildPayload", () => {
  const baseEvent = {
    type: "run.completed" as const,
    runId: "r1",
    projectId: "p1",
    status: "failed" as RunStatus,
    diffPercent: 4.2,
    branchName: "feat/x",
    numChanges: 7,
  };
  const baseInput = {
    event: baseEvent,
    branchName: "feat/x",
    severityCounts: { breaking: 1, major: 2, minor: 0, cosmetic: 4 },
    dashboardUrl: "https://app.furan.dev/x",
  };

  test("Slack URL returns Block Kit shape", () => {
    const out = buildPayload(
      "https://hooks.slack.com/services/x/y/z",
      baseInput,
    );
    expect(out).not.toBeNull();
    expect(out).toHaveProperty("blocks");
  });

  test("non-Slack URL returns generic envelope", () => {
    const out = buildPayload("https://example.com/hook", baseInput) as {
      event: string;
      status: string;
      runId: string;
      branchName?: string;
    };
    expect(out.event).toBe("run.completed");
    expect(out.status).toBe("failed");
    expect(out.runId).toBe("r1");
    expect(out.branchName).toBe("feat/x");
  });

  test("generic envelope omits absent optional fields", () => {
    const out = buildPayload("https://example.com/hook", {
      ...baseInput,
      event: { type: "run.completed", runId: "r2" },
      branchName: "",
    }) as Record<string, unknown>;
    expect(out.runId).toBe("r2");
    expect(out.status).toBeUndefined();
    expect(out.branchName).toBeUndefined();
    expect(out.diffPercent).toBeUndefined();
  });
});

describe("Slack gate on terminal status (spec §3.4)", () => {
  const slackUrl = "https://hooks.slack.com/services/x/y/z";
  const baseInput = {
    branchName: "feat/x",
    severityCounts: { breaking: 0, major: 0, minor: 0, cosmetic: 0 },
    dashboardUrl: "https://app.furan.dev/x",
  };

  test("status=running → Slack payload is null (no notification fires)", () => {
    // The whole point: `running` is not terminal under the new 7-value
    // taxonomy. Sending a Slack message for it would spam channels with
    // intermediate noise during a long-running test.
    const out = buildPayload(slackUrl, {
      ...baseInput,
      event: {
        type: "run.completed",
        runId: "r1",
        status: "running",
        projectId: "p1",
      },
    });
    expect(out).toBeNull();
  });

  test("status=unresolved → Slack payload is built (review-required notify)", () => {
    const out = buildPayload(slackUrl, {
      ...baseInput,
      event: {
        type: "run.completed",
        runId: "r1",
        status: "unresolved",
        projectId: "p1",
      },
    });
    expect(out).not.toBeNull();
    expect(out).toHaveProperty("blocks");
  });

  for (const status of [
    "new",
    "passed",
    "unresolved",
    "failed",
    "aborted",
    "empty",
  ] as const) {
    test(`status=${status} → Slack payload is built (terminal)`, () => {
      const out = buildPayload(slackUrl, {
        ...baseInput,
        event: {
          type: "run.completed",
          runId: "r1",
          status,
          projectId: "p1",
        },
      });
      expect(out).not.toBeNull();
    });
  }

  test("generic (non-Slack) subscriber still receives running payload", () => {
    // Generic webhooks deliberately are NOT gated — they may want to
    // build their own state machines downstream. The gate is Slack-only.
    const out = buildPayload("https://example.com/hook", {
      ...baseInput,
      event: {
        type: "run.completed",
        runId: "r1",
        status: "running",
        projectId: "p1",
      },
    });
    expect(out).not.toBeNull();
    expect(out).toHaveProperty("event", "run.completed");
  });
});
