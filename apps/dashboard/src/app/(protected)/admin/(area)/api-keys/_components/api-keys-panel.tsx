"use client";

import { KeyRound, Plus } from "lucide-react";
import { useRouter } from "next/navigation";

import { ApiKeyCard } from "./api-key-card";

import { CreateTokenDialog } from "@/app/(protected)/account/tokens/_components/create-token-dialog";
import type { TokenRow } from "@/app/(protected)/account/tokens/_components/tokens-table";
import { Button } from "@/components/ui/button";

interface Props {
  initialTokens: TokenRow[];
}

export function ApiKeysPanel({ initialTokens }: Props) {
  const router = useRouter();
  const tokens = initialTokens;
  const refresh = () => router.refresh();

  return (
    <div className="overflow-hidden rounded-lg bg-raised shadow-raised">
      <div className="border-b border-edge px-6 py-4">
        <h3 className="text-base font-medium text-fg">API Keys</h3>
        <p className="mt-1 text-xs text-fg-muted">
          Use these tokens to authenticate Furan from your CI or test runner. A
          key works on the projects your account can access, but it can&apos;t
          manage keys or use admin features — sign in for those.
        </p>
      </div>
      <div className="p-6">
        {tokens.length === 0 ? (
          <div className="py-8 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-edge bg-hover">
              <KeyRound className="h-5 w-5 text-fg-muted" />
            </div>
            <p className="text-sm font-medium text-fg">No API keys yet</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-fg-muted">
              Generate a key and paste it into your CI as the FURAN_API_TOKEN
              env var.
            </p>
            <div className="mt-4">
              <CreateTokenDialog onCreated={refresh}>
                <Button data-testid="create-token-button">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Generate new key
                </Button>
              </CreateTokenDialog>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {tokens.map((t) => (
                <ApiKeyCard
                  key={t.id}
                  id={t.id}
                  label={t.label}
                  createdAt={t.createdAt}
                  lastUsedAt={t.lastUsedAt}
                  onDeleted={refresh}
                />
              ))}
            </div>
            <div className="mt-4">
              <CreateTokenDialog onCreated={refresh}>
                <Button data-testid="create-token-button">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Generate new key
                </Button>
              </CreateTokenDialog>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
