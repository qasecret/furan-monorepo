"use client";

import { Info } from "lucide-react";
import { useState } from "react";

import type { BatchHeaderData } from "./batch-header";

import { DocsLink } from "@/components/docs-link";

type Counts = Pick<
  BatchHeaderData,
  "id" | "runCount" | "newCount" | "passedCount" | "runningCount"
>;

/**
 * The first-batch hint under the batch header (first-run spec §5). While
 * every test is New there is nothing to compare: say so, and that approving
 * saves the baselines. If the batch was all New when this page view saw it
 * and every test has since passed, say to run again. The trigger is "every
 * test is New", not "first batch" (build numbers come from the SDK). Not
 * `aggregateStatus`: New counts as passed there, so an all-New batch already
 * reads Passed before anything is approved.
 *
 * Whether the batch was all New is fixed once its runs have settled (a
 * running run counts as neither New nor passed), and again when more runs
 * arrive; approving changes neither, and another batch starts over.
 */
export function FirstBatchHint({ build }: { build: Counts }) {
  const settled = build.runningCount === 0;
  const key = `${build.id}:${build.runCount}`;
  const [seen, setSeen] = useState<{ key: string; wasAllNew: boolean } | null>(
    null,
  );
  let current = seen;
  if (settled && seen?.key !== key) {
    // Adjusting state while rendering: React re-renders at once, before paint.
    current = {
      key,
      wasAllNew: build.runCount > 0 && build.newCount === build.runCount,
    };
    setSeen(current);
  }
  if (!settled || current?.key !== key) return null;
  const { wasAllNew } = current;
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
