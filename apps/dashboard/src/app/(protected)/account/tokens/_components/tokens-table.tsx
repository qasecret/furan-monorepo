"use client";

import { KeyRound, Plus, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";

import { CreateTokenDialog } from "./create-token-dialog";
import { DeleteTokenButton } from "./delete-token-button";
import {
  FALLBACK_TOKEN_POLICY,
  relative,
  type ProjectOption,
  type TokenPolicy,
  type TokenRow,
} from "./token-grant";
import {
  ExpiryText,
  LegacyTokensNotice,
  ProjectText,
  ScopeBadge,
} from "./token-grant-badges";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type { TokenRow } from "./token-grant";

interface TokensTableProps {
  initialTokens: TokenRow[];
  projects?: ProjectOption[];
  policy?: TokenPolicy;
}

function EmptyTokens({ create }: { create: React.ReactNode }) {
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
        <div className="mt-4">{create}</div>
      </div>
    </div>
  );
}

export function TokensTable({
  initialTokens,
  projects = [],
  policy = FALLBACK_TOKEN_POLICY,
}: TokensTableProps) {
  const router = useRouter();
  const tokens = initialTokens;
  const create = (
    <CreateTokenDialog
      projects={projects}
      policy={policy}
      onCreated={() => router.refresh()}
    >
      <Button data-testid="create-token-button">
        <Plus className="mr-1.5 h-4 w-4" />
        Create token
      </Button>
    </CreateTokenDialog>
  );

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
              Authenticate the Furan SDK or CI uploads. A token works on one
              project or on all your projects until it expires, and it
              can&apos;t manage tokens or use admin features — sign in for
              those.
            </p>
          </div>
          {tokens.length > 0 && create}
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

        <LegacyTokensNotice tokens={tokens} />

        {tokens.length === 0 ? (
          <EmptyTokens create={create} />
        ) : (
          <Table data-testid="tokens-table">
            <TableHeader>
              <tr>
                <TableHead>Label</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id} data-testid={`token-row-${t.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge bg-edge">
                        <KeyRound className="h-3.5 w-3.5 text-fg-muted" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-fg">{t.label}</div>
                        <div className="text-xs tabular-nums text-fg-muted">
                          Created {relative(t.createdAt)}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <ScopeBadge token={t} />
                  </TableCell>
                  <TableCell>
                    <ProjectText token={t} />
                  </TableCell>
                  <TableCell>
                    <ExpiryText token={t} />
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
                    {t.lastUsedAt && t.lastUsedIp && (
                      <div
                        className="font-mono text-2xs text-fg-muted"
                        data-testid="token-last-ip"
                      >
                        from {t.lastUsedIp}
                      </div>
                    )}
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
