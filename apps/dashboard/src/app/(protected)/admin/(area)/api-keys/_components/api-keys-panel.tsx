"use client";

import { KeyRound, Plus } from "lucide-react";
import { useRouter } from "next/navigation";

import { ApiKeyCard } from "./api-key-card";

import { CreateTokenDialog } from "@/app/(protected)/account/tokens/_components/create-token-dialog";
import {
  FALLBACK_TOKEN_POLICY,
  type ProjectOption,
  type TokenPolicy,
  type TokenRow,
} from "@/app/(protected)/account/tokens/_components/token-grant";
import { LegacyTokensNotice } from "@/app/(protected)/account/tokens/_components/token-grant-badges";
import { Button } from "@/components/ui/button";

interface Props {
  initialTokens: TokenRow[];
  projects?: ProjectOption[];
  policy?: TokenPolicy;
}

export function ApiKeysPanel({
  initialTokens,
  projects = [],
  policy = FALLBACK_TOKEN_POLICY,
}: Props) {
  const router = useRouter();
  const tokens = initialTokens;
  const refresh = () => router.refresh();
  const create = (
    <CreateTokenDialog projects={projects} policy={policy} onCreated={refresh}>
      <Button data-testid="create-token-button">
        <Plus className="mr-1.5 h-4 w-4" />
        Create token
      </Button>
    </CreateTokenDialog>
  );

  return (
    <div className="overflow-hidden rounded-lg bg-raised shadow-raised">
      <div className="border-b border-edge px-6 py-4">
        <h3 className="text-base font-medium text-fg">API Tokens</h3>
        <p className="mt-1 text-xs text-fg-muted">
          Use these tokens to authenticate Furan from your CI or test runner. A
          token works on one project, or on the projects you&apos;re a member of,
          until it expires. It can&apos;t manage tokens or use admin features —
          sign in for those.
        </p>
      </div>
      <div className="p-6">
        <LegacyTokensNotice tokens={tokens} />
        {tokens.length === 0 ? (
          <div className="py-8 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-edge bg-hover">
              <KeyRound className="h-5 w-5 text-fg-muted" />
            </div>
            <p className="text-sm font-medium text-fg">No API tokens yet</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-fg-muted">
              Create a token and add it to your CI as FURAN_API_TOKEN.
            </p>
            <div className="mt-4">{create}</div>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {tokens.map((t) => (
                <ApiKeyCard key={t.id} token={t} onDeleted={refresh} />
              ))}
            </div>
            <div className="mt-4">{create}</div>
          </>
        )}
      </div>
    </div>
  );
}
