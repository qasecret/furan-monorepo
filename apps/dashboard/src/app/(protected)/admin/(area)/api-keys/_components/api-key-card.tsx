"use client";

import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteTokenButton } from "../../../../account/tokens/_components/delete-token-button";

interface Props {
  id: string;
  label: string;
  createdAt: string | Date;
  lastUsedAt: string | Date | null;
  onDeleted: () => void;
}

function fmtDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function relative(date: string | Date | null): string {
  if (!date) return "Never";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

export function ApiKeyCard({
  id,
  label,
  createdAt,
  lastUsedAt,
  onDeleted,
}: Props) {
  const [copied, setCopied] = useState(false);
  const maskedKey = `furan_pat_**********************${id.slice(-4)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(maskedKey);
      setCopied(true);
      toast.success("Key ID copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <KeyRound className="h-4 w-4 text-brand-text" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-950 dark:text-white">
            {label}
          </div>
          <div className="truncate font-mono text-xs text-zinc-400 dark:text-zinc-500">
            {maskedKey}
          </div>
          <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-zinc-400 dark:text-zinc-600">
            <span>Created {fmtDate(createdAt)}</span>
            <span>&middot;</span>
            <span>
              Last used{" "}
              <span
                className={
                  lastUsedAt ? "" : "italic text-zinc-300 dark:text-zinc-700"
                }
              >
                {relative(lastUsedAt)}
              </span>
            </span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={() => void handleCopy()}
          className="rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-white"
          title="Copy key ID"
        >
          <Copy className={`h-4 w-4 ${copied ? "text-emerald-500" : ""}`} />
        </button>
        <DeleteTokenButton tokenId={id} label={label} onDeleted={onDeleted}>
          <button
            className="rounded-md p-2 text-zinc-400 transition-colors hover:bg-red-100 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-red-400"
            title="Revoke"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </DeleteTokenButton>
      </div>
    </div>
  );
}
