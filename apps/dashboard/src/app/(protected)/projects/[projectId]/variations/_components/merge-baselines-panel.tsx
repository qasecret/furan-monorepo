"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ViewerRole } from "@/lib/roles";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  userRole: ViewerRole;
}

/**
 * Reviewer-facing entry point for cross-branch baseline promotion. Lists
 * branches that have at least one baseline in the project, lets the
 * reviewer pick a from/to pair, then calls `projects.mergeBranchBaselines`.
 *
 * On success the panel routes the reviewer to the synthetic build page so
 * they can review the per-variation outcomes — byte-identical sources will
 * already have auto-approved (ADR-032); divergent sources land as
 * `unresolved` for explicit review.
 *
 * Disabled states:
 *  - guest role: the mutation requires `project_members("write")` so a
 *    guest's submit would 403 server-side; we also disable client-side
 *    so the affordance isn't dangled in front of them.
 *  - branches not loaded / either selector empty / same-branch: the
 *    backend would reject same-branch with BAD_REQUEST, but disabling
 *    in the UI avoids the round-trip.
 *
 * Spec: furan-design/specs/2026-05-24-cross-branch-baseline-merge-design.md
 */
export function MergeBaselinesPanel({ projectId, userRole }: Props) {
  const router = useRouter();
  const isGuest = userRole === "guest";
  const branches = trpc.projects.listBranches.useQuery({ projectId });
  const [fromBranch, setFromBranch] = useState("");
  const [toBranch, setToBranch] = useState("");

  const mutation = trpc.projects.mergeBranchBaselines.useMutation({
    onSuccess: (result) => {
      if (result.runCount === 0 && result.skippedCount === 0) {
        toast.info(
          `No baselines on ${result.fromBranch} — nothing to promote.`,
        );
        return;
      }
      const skippedSuffix =
        result.skippedCount > 0 ? ` (${result.skippedCount} skipped)` : "";
      toast.success(
        `${result.runCount} variations queued for review on ${result.toBranch}${skippedSuffix}.`,
      );
      router.push(`/projects/${projectId}/builds/${result.buildId}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const disabled =
    isGuest ||
    !fromBranch ||
    !toBranch ||
    fromBranch === toBranch ||
    mutation.isPending;

  return (
    <Card data-testid="merge-baselines-panel">
      <CardHeader>
        <CardTitle>Merge baselines</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-fg-secondary">
          Promote approved baselines from one branch to another. Each variation
          with a baseline on the source branch becomes a synthetic{" "}
          <code className="rounded bg-hover px-1 py-0.5 text-xs text-fg-secondary">
            merge=true
          </code>{" "}
          test run on the destination branch for reviewer approval. Byte-
          identical sources auto-approve into the new destination baseline;
          divergent sources land as <em>unresolved</em> for explicit review.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <BranchSelect
            label="From branch"
            value={fromBranch}
            onChange={setFromBranch}
            options={branches.data ?? []}
            disabled={isGuest}
            testId="merge-from-branch"
          />
          <BranchSelect
            label="To branch"
            value={toBranch}
            onChange={setToBranch}
            options={branches.data ?? []}
            disabled={isGuest}
            testId="merge-to-branch"
          />
          <Button
            disabled={disabled}
            onClick={() => mutation.mutate({ projectId, fromBranch, toBranch })}
            data-testid="merge-baselines-submit"
          >
            {mutation.isPending ? "Merging…" : "Merge baselines"}
          </Button>
        </div>
        {fromBranch && toBranch && fromBranch === toBranch && (
          <p className="text-xs text-destructive">
            Source and destination branches must differ.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BranchSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  disabled: boolean;
  testId: string;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={testId}
        className="text-xs font-medium uppercase tracking-wider text-fg-secondary"
      >
        {label}
      </label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={testId} className="w-56" data-testid={testId}>
          <SelectValue placeholder="Select branch…" />
        </SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <SelectItem value="__none" disabled>
              No branches with baselines yet
            </SelectItem>
          ) : (
            options.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
