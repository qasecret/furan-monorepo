"use client";

import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { DeleteTokenButton } from "../../../../account/tokens/_components/delete-token-button";
import {
  formatDate,
  relative,
  type TokenRow,
} from "../../../../account/tokens/_components/token-grant";
import {
  ExpiryText,
  ProjectText,
  ScopeBadge,
} from "../../../../account/tokens/_components/token-grant-badges";

interface Props {
  token: TokenRow;
  onDeleted: () => void;
}

export function ApiKeyCard({ token, onDeleted }: Props) {
  const { id, label, createdAt, lastUsedAt, lastUsedIp } = token;
  const [copied, setCopied] = useState(false);
  const maskedKey = `furan_pat_**********************${id.slice(-4)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(maskedKey);
      setCopied(true);
      toast.success("Token ID copied");
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
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{label}</span>
            <ScopeBadge token={token} />
          </div>
          <div className="truncate font-mono text-xs tabular-nums text-fg-muted">
            {maskedKey}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <ProjectText token={token} />
            <span aria-hidden className="text-edge-strong">
              &middot;
            </span>
            <ExpiryText token={token} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 font-mono text-2xs tabular-nums text-fg-muted">
            <span>Created {formatDate(createdAt)}</span>
            <span aria-hidden className="text-edge-strong">
              &middot;
            </span>
            <span>
              Last used{" "}
              <span className={lastUsedAt ? "" : "italic"}>
                {relative(lastUsedAt)}
              </span>
              {lastUsedAt && lastUsedIp ? ` from ${lastUsedIp}` : null}
            </span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={() => void handleCopy()}
          className="rounded-md p-2 text-fg-muted transition-colors hover:bg-edge hover:text-fg focus-ring"
          title="Copy token ID"
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
