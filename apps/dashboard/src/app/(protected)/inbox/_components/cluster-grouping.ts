import type { InboxRunRow } from "@furan/shared-types";

export interface ClusterGroup {
  kind: "cluster";
  projectId: string;
  signature: string;
  /** True cross-build totals from the server (may exceed the rows on this page). */
  runCount: number;
  buildCount: number;
  rows: InboxRunRow[];
}
export interface SingleGroup {
  kind: "single";
  row: InboxRunRow;
}
export type QueueGroup = ClusterGroup | SingleGroup;

/**
 * Fold the cluster-contiguous inbox rows (similarity mode) into render groups.
 * A run joins a cluster iff it has a primarySignature AND clusterRunCount > 1;
 * consecutive rows sharing (projectId, primarySignature) accumulate. Everything
 * else (clusterRunCount === 1, or NULL primarySignature) is a singleton — NULL
 * rows must never collapse into one false cluster.
 */
export function groupIntoClusters(items: InboxRunRow[]): QueueGroup[] {
  const groups: QueueGroup[] = [];
  for (const row of items) {
    const inCluster =
      row.primarySignature != null && (row.clusterRunCount ?? 1) > 1;
    if (!inCluster) {
      groups.push({ kind: "single", row });
      continue;
    }
    const prev = groups[groups.length - 1];
    if (
      prev &&
      prev.kind === "cluster" &&
      prev.projectId === row.projectId &&
      prev.signature === row.primarySignature
    ) {
      prev.rows.push(row);
    } else {
      groups.push({
        kind: "cluster",
        projectId: row.projectId,
        signature: row.primarySignature,
        runCount: row.clusterRunCount ?? 1,
        buildCount: row.clusterBuildCount ?? 1,
        rows: [row],
      });
    }
  }
  return groups;
}
