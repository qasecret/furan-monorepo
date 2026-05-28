"use client";

import { History, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";

interface Props {
  testVariationId: string;
  currentBaselineKey: string | null;
}

/**
 * Right-side drawer listing every baseline the current variation has
 * had, newest first. The "current" entry — the one whose
 * `baselineName` matches what the diff worker compared against — is
 * highlighted.
 *
 * Auto-approves (userId IS NULL on the baselines row, set by the
 * diff-worker when candidate bytes match the prior baseline exactly)
 * render as "system" with a muted label; manual approves show the
 * approver's email.
 *
 * Sheet is not available in this project's UI primitives; we use
 * Dialog with right-side fixed positioning instead.
 */
export function BaselineHistoryPanel({
  testVariationId,
  currentBaselineKey,
}: Props) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = trpc.baselines.listForVariation.useQuery(
    { testVariationId },
    { enabled: open },
  );

  return (
    <>
      <Button
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
        onClick={() => setOpen(true)}
        data-testid="diff-viewer-baseline-history-button"
      >
        <History className="h-3.5 w-3.5" aria-hidden />
        Baseline history
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="fixed inset-y-0 right-0 left-auto h-full w-96 max-w-[90vw] translate-x-0 translate-y-0 -translate-x-0 -translate-y-0 rounded-none border-l border-zinc-200 bg-white p-0 sm:max-w-md dark:border-zinc-800 dark:bg-zinc-950"
          style={{ transform: "none", top: 0, margin: 0 }}
          data-testid="baseline-history-panel"
        >
          <div className="flex h-full flex-col">
            <DialogHeader className="flex flex-row items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <DialogTitle className="text-base font-semibold text-zinc-950 dark:text-white">
                Baseline history
              </DialogTitle>
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  className="h-7 w-7 p-0 text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
                  aria-label="Close baseline history"
                >
                  <X className="h-4 w-4" />
                </Button>
              </DialogClose>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {isLoading ? (
                <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
                  Loading…
                </p>
              ) : !data || data.items.length === 0 ? (
                <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
                  No baselines accepted yet.
                </p>
              ) : (
                <ul role="list" className="space-y-2">
                  {data.items.map((b) => {
                    const isCurrent =
                      currentBaselineKey !== null &&
                      b.baselineName === currentBaselineKey;
                    return (
                      <li
                        key={b.id}
                        data-testid={`baseline-history-row-${b.id}`}
                        className={
                          isCurrent
                            ? "rounded border border-[color:var(--color-brand)]/40 bg-[color:var(--color-brand)]/5 p-3"
                            : "rounded border border-zinc-200 bg-zinc-100/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-zinc-950 dark:text-white">
                            {b.isAuto
                              ? "System (auto-approved)"
                              : (b.approverEmail ?? "Unknown")}
                          </span>
                          {isCurrent && (
                            <span className="rounded-full bg-[color:var(--color-brand)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-brand)]">
                              current
                            </span>
                          )}
                        </div>
                        <div className="mt-1 font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                          {new Date(b.createdAt).toLocaleString()} ·{" "}
                          {b.branchName}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
