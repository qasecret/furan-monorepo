"use client";

import { Info } from "lucide-react";
import { useRef } from "react";

import type { BatchHeaderData } from "./batch-header";

import { DocsLink } from "@/components/docs-link";

type Counts = Pick<
  BatchHeaderData,
  "id" | "runCount" | "newCount" | "passedCount"
>;

/**
 * The first-batch hint under the batch header (first-run spec §5). While
 * every test is New there is nothing to compare: say so, and that approving
 * saves the baselines. If the batch was all New when this page view saw it
 * and every test has since passed, say to run again. The trigger is "every
 * test is New", not "first batch" (build numbers come from the SDK). Not
 * `aggregateStatus`: New counts as passed there, so an all-New batch already
 * reads Passed before anything is approved.
 */
export function FirstBatchHint({ build }: { build: Counts }) {
  // Fixed the first time this build id is seen, so another batch starts over.
  const seen = useRef<{ id: string; wasAllNew: boolean } | null>(null);
  if (seen.current?.id !== build.id) {
    seen.current = {
      id: build.id,
      wasAllNew: build.runCount > 0 && build.newCount === build.runCount,
    };
  }
  const { wasAllNew } = seen.current;
  const before = wasAllNew && build.newCount > 0;
  const after =
    wasAllNew && build.newCount === 0 && build.passedCount === build.runCount;
  if (!before && !after) return null;

  return (
    <div
      role="status"
      data-testid="first-batch-hint"
      className="flex items-center gap-2 border-b border-edge bg-sunken px-4 py-2 text-sm text-fg-secondary"
    >
      <Info className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
      {before ? (
        <p>
          Every test in this batch is new, so there&apos;s nothing to compare
          with yet. Check the screenshots, then{" "}
          <strong className="font-medium text-fg">Approve pending</strong> to
          save them as baselines.{" "}
          <DocsLink slug="getting-started/first-baseline">
            About baselines
          </DocsLink>
        </p>
      ) : (
        <p>
          Baselines saved. Run your tests again: the next batch is compared with
          these.{" "}
          <DocsLink slug="getting-started/first-diff">
            Reviewing your first diff
          </DocsLink>
        </p>
      )}
    </div>
  );
}
