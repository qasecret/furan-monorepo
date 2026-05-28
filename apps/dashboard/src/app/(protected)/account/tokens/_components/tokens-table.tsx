"use client";

import { useRouter } from "next/navigation";

import { CreateTokenDialog } from "./create-token-dialog";
import { DeleteTokenButton } from "./delete-token-button";

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
  if (!date) return "—";
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

export function TokensTable({ initialTokens }: TokensTableProps) {
  const router = useRouter();
  const tokens = initialTokens;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CreateTokenDialog onCreated={() => router.refresh()} />
      </div>
      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-sm" data-testid="tokens-table">
          <thead className="bg-zinc-100/70 border-b border-zinc-200 text-zinc-600 text-left dark:bg-zinc-900/50 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Label</th>
              <th className="px-4 py-2.5 font-medium">Created</th>
              <th className="px-4 py-2.5 font-medium">Last used</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {tokens.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-500"
                  data-testid="tokens-empty"
                >
                  No tokens yet. Create one above.
                </td>
              </tr>
            ) : (
              tokens.map((t) => (
                <tr
                  key={t.id}
                  className="hover:bg-zinc-100/60 transition-colors dark:hover:bg-zinc-900/30"
                  data-testid={`token-row-${t.id}`}
                >
                  <td className="px-4 py-2.5 font-medium">{t.label}</td>
                  <td className="px-4 py-2.5 text-zinc-500 dark:text-zinc-500">
                    {relative(t.createdAt)}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 dark:text-zinc-500">
                    {relative(t.lastUsedAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <DeleteTokenButton
                      tokenId={t.id}
                      label={t.label}
                      onDeleted={() => router.refresh()}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
