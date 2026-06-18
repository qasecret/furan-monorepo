import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClusterBlock } from "../src/app/(protected)/inbox/_components/cluster-block";
import type { ClusterGroup } from "../src/app/(protected)/inbox/_components/cluster-grouping";

afterEach(cleanup);

const cluster: ClusterGroup = {
  kind: "cluster",
  projectId: "p1",
  signature: "v1:a",
  runCount: 7,
  buildCount: 3,
  rows: [
    {
      runId: "r1",
      projectId: "p1",
      projectName: "P",
      variationName: "Checkout",
      buildNumber: 1,
      branch: "main",
      status: "unresolved",
      createdAt: "2026-06-18T00:00:00.000Z",
      thumbnailUrl: null,
      primarySignature: "v1:a",
      clusterRunCount: 7,
      clusterBuildCount: 3,
    },
  ] as ClusterGroup["rows"],
};

describe("ClusterBlock", () => {
  it("shows the cross-build header counts + member rows + a Reject all button", () => {
    render(
      <ClusterBlock
        cluster={cluster}
        baseIndex={0}
        selectedIndex={-1}
        onApprove={() => undefined}
        onReject={() => undefined}
        onRejectAll={() => undefined}
      />,
    );
    const header = screen.getByTestId("cluster-header-v1:a");
    expect(header.textContent).toContain("7 runs");
    expect(header.textContent).toContain("3 builds");
    expect(screen.getByTestId("queue-row-r1")).toBeTruthy();
  });

  it("Reject all fires onRejectAll with the cluster", () => {
    const onRejectAll = vi.fn();
    render(
      <ClusterBlock
        cluster={cluster}
        baseIndex={0}
        selectedIndex={-1}
        onApprove={() => undefined}
        onReject={() => undefined}
        onRejectAll={onRejectAll}
      />,
    );
    fireEvent.click(screen.getByTestId("cluster-reject-all-v1:a"));
    expect(onRejectAll).toHaveBeenCalledWith(cluster);
  });
});
