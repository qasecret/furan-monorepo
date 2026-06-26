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
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <h3 className="text-base font-medium text-zinc-950 dark:text-white">
          API Keys
        </h3>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Use these tokens to authenticate Furan from your CI or test runner.
        </p>
      </div>
      <div className="p-6">
        {tokens.length === 0 ? (
          <div className="py-8 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
              <KeyRound className="h-5 w-5 text-zinc-400" />
            </div>
            <p className="text-sm font-medium text-zinc-950 dark:text-white">
              No API keys yet
            </p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-zinc-500 dark:text-zinc-400">
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
