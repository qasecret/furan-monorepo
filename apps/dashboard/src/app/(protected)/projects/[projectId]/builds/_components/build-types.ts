import type { BuildAggregateStatus } from "@furan/shared-types";

export interface BuildRowData {
  id: string;
  ciBuildId: string | null;
  number: number | null;
  branchName: string | null;
  name: string | null;
  properties: Record<string, string>;
  runCount: number;
  unresolvedCount: number;
  failedCount: number;
  passedCount: number;
  abortedCount: number;
  aggregateStatus: BuildAggregateStatus;
  createdAt: string | Date;
}
