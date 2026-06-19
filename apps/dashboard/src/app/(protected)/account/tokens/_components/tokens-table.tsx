"use client";

import { useRouter } from "next/navigation";

import { CreateTokenDialog } from "./create-token-dialog";
import { DeleteTokenButton } from "./delete-token-button";

import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
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
          {tokens.length === 0 ? (
            <TableEmpty colSpan={4} data-testid="tokens-empty">
              No tokens yet. Create one above.
            </TableEmpty>
          ) : (
            tokens.map((t) => (
              <TableRow key={t.id} data-testid={`token-row-${t.id}`}>
                <TableCell className="font-medium">{t.label}</TableCell>
                <TableCell className="text-zinc-500 dark:text-zinc-500">
                  {relative(t.createdAt)}
                </TableCell>
                <TableCell className="text-zinc-500 dark:text-zinc-500">
                  {relative(t.lastUsedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <DeleteTokenButton
                    tokenId={t.id}
                    label={t.label}
                    onDeleted={() => router.refresh()}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
