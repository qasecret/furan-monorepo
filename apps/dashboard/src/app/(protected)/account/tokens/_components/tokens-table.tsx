"use client";

import { KeyRound, Plus, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";

import { CreateTokenDialog } from "./create-token-dialog";
import { DeleteTokenButton } from "./delete-token-button";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface TokenRow {
  id: string;
  label: string;
  createdAt: string | Date;
  lastUsedAt: string | Date | null;
}

interface TokensTableProps {
  initialTokens: TokenRow[];
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

function EmptyTokens({ onCreated }: { onCreated: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="mx-auto max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-edge bg-hover">
          <KeyRound className="h-5 w-5 text-fg-muted" />
        </div>
        <h3 className="text-base font-medium text-fg">No tokens yet</h3>
        <p className="mx-auto mt-1 max-w-xs text-sm text-fg-muted">
          Create a personal access token to authenticate the Furan SDK or CI
          uploads.
        </p>
        <div className="mt-4">
          <CreateTokenDialog onCreated={onCreated}>
            <Button data-testid="create-token-button">
              <Plus className="mr-1.5 h-4 w-4" />
              Create token
            </Button>
          </CreateTokenDialog>
        </div>
      </div>
    </div>
  );
}

export function TokensTable({ initialTokens }: TokensTableProps) {
  const router = useRouter();
  const tokens = initialTokens;

  return (
    <>
      {/* Header */}
      <header className="border-b border-edge px-6 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-fg">
              Personal access tokens
            </h1>
            <p className="mt-1 text-sm text-fg-muted">
              Authenticate the Furan SDK or CI uploads. A token works on the
              projects your account can access, but it can&apos;t manage tokens
              or use admin features — sign in for those.
            </p>
          </div>
          {tokens.length > 0 && (
            <CreateTokenDialog onCreated={() => router.refresh()}>
              <Button data-testid="create-token-button">
                <Plus className="mr-1.5 h-4 w-4" />
                Create token
              </Button>
            </CreateTokenDialog>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 flex-col overflow-y-auto p-6">
        {/* Security callout */}
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3">
          <ShieldAlert
            aria-hidden
            className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
          />
          <p className="text-xs leading-relaxed text-fg">
            Tokens are shown only once on creation. Store them in a secrets
            manager — never commit them to source control.
          </p>
        </div>

        {tokens.length === 0 ? (
          <EmptyTokens onCreated={() => router.refresh()} />
        ) : (
          <Table data-testid="tokens-table">
            <TableHeader>
              <tr>
                <TableHead>Label</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id} data-testid={`token-row-${t.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge bg-hover">
                        <KeyRound className="h-3.5 w-3.5 text-fg-muted" />
                      </div>
                      <span className="font-medium text-fg">{t.label}</span>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums text-fg-muted">
                    {relative(t.createdAt)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        t.lastUsedAt
                          ? "tabular-nums text-fg-muted"
                          : "italic text-fg-muted"
                      }
                    >
                      {relative(t.lastUsedAt)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <DeleteTokenButton
                      tokenId={t.id}
                      label={t.label}
                      onDeleted={() => router.refresh()}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
