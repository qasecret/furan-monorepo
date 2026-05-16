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
      <table
        className="w-full text-sm border-collapse"
        data-testid="tokens-table"
      >
        <thead className="text-left text-muted-foreground border-b">
          <tr>
            <th className="py-2 pr-2">Label</th>
            <th className="py-2 pr-2">Created</th>
            <th className="py-2 pr-2">Last used</th>
            <th className="py-2 pr-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {tokens.length === 0 ? (
            <tr>
              <td
                colSpan={4}
                className="py-6 text-center text-muted-foreground"
                data-testid="tokens-empty"
              >
                No tokens yet. Create one above.
              </td>
            </tr>
          ) : (
            tokens.map((t) => (
              <tr
                key={t.id}
                className="border-b last:border-0"
                data-testid={`token-row-${t.id}`}
              >
                <td className="py-2 pr-2 font-medium">{t.label}</td>
                <td className="py-2 pr-2 text-muted-foreground">
                  {relative(t.createdAt)}
                </td>
                <td className="py-2 pr-2 text-muted-foreground">
                  {relative(t.lastUsedAt)}
                </td>
                <td className="py-2 pr-2 text-right">
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
  );
}
