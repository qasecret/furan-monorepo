import { describe, expect, it } from "vitest";

import { groupIntoClusters } from "../src/app/(protected)/inbox/_components/cluster-grouping";

type Row = Parameters<typeof groupIntoClusters>[0][number];
const row = (over: Partial<Row>): Row =>
  ({
    runId: "r" + Math.random().toString(36).slice(2),
    projectId: "p1",
    projectName: "P",
    variationName: "Run",
    buildNumber: 1,
    branch: "main",
    status: "unresolved",
    createdAt: "2026-06-18T00:00:00.000Z",
    thumbnailUrl: null,
    primarySignature: null,
    clusterRunCount: 1,
    clusterBuildCount: 1,
    ...over,
  }) as Row;

describe("groupIntoClusters", () => {
  it("groups consecutive rows sharing (projectId, primarySignature) into a cluster", () => {
    const a1 = row({
      primarySignature: "v1:a",
      clusterRunCount: 2,
      clusterBuildCount: 2,
    });
    const a2 = row({
      primarySignature: "v1:a",
      clusterRunCount: 2,
      clusterBuildCount: 2,
    });
    const single = row({ primarySignature: "v1:b", clusterRunCount: 1 });
    const groups = groupIntoClusters([a1, a2, single]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: "cluster",
      signature: "v1:a",
      runCount: 2,
      buildCount: 2,
    });
    expect((groups[0] as { rows: Row[] }).rows).toHaveLength(2);
    expect(groups[1]).toMatchObject({ kind: "single" });
  });

  it("treats clusterRunCount===1 and NULL primarySignature as singletons (never one mega-cluster)", () => {
    const n1 = row({ primarySignature: null });
    const n2 = row({ primarySignature: null });
    const groups = groupIntoClusters([n1, n2]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === "single")).toBe(true);
  });

  it("splits same-signature rows from different projects", () => {
    const p1 = row({
      projectId: "p1",
      primarySignature: "v1:x",
      clusterRunCount: 2,
    });
    const p2 = row({
      projectId: "p2",
      primarySignature: "v1:x",
      clusterRunCount: 2,
    });
    const groups = groupIntoClusters([p1, p2]);
    // Different projects → two singletons here (each appears once, contiguous by project in real data).
    expect(groups).toHaveLength(2);
  });
});
