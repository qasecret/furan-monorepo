import { describe, expect, it } from "vitest";

import { summarize } from "@/app/(protected)/admin/(area)/audit-log/_components/audit-log-table";

describe("audit log details", () => {
  it("shows nested metadata as JSON instead of [object Object]", () => {
    expect(
      summarize({
        fields: ["diffThreshold"],
        changes: { diffThreshold: { from: 0.001, to: 0 } },
      }),
    ).toBe(
      'fields: ["diffThreshold"], changes: {"diffThreshold":{"from":0.001,"to":0}}',
    );
  });

  it("keeps plain values as they are", () => {
    expect(summarize({ role: "editor", count: 3, ok: true })).toBe(
      "role: editor, count: 3, ok: true",
    );
    expect(summarize(null)).toBe("");
  });
});
