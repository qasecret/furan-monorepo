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
    <div className="flex items-center justify-between gap-4 rounded-lg border border-edge bg-sunken p-4">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge bg-raised">
          <KeyRound className="h-4 w-4 text-brand-text" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{label}</div>
          <div className="truncate font-mono text-xs tabular-nums text-fg-muted">
            {maskedKey}
          </div>
          <div className="mt-1 flex items-center gap-3 font-mono text-2xs tabular-nums text-fg-muted">
            <span>Created {fmtDate(createdAt)}</span>
            <span aria-hidden className="text-edge-strong">
              &middot;
            </span>
            <span>
              Last used{" "}
              <span className={lastUsedAt ? "" : "italic"}>
                {relative(lastUsedAt)}
              </span>
            </span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={() => void handleCopy()}
          className="rounded-md p-2 text-fg-muted transition-colors hover:bg-edge hover:text-fg focus-ring"
          title="Copy key ID"
        >
          <Copy className={`h-4 w-4 ${copied ? "text-emerald-600" : ""}`} />
        </button>
        <DeleteTokenButton tokenId={id} label={label} onDeleted={onDeleted}>
          <button
            className="rounded-md p-2 text-fg-muted transition-colors hover:bg-destructive/10 hover:text-destructive focus-ring"
            title="Revoke"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </DeleteTokenButton>
      </div>
    </div>
  );
}
