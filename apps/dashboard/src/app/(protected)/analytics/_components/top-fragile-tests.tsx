"use client";

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { statusStyle } from "@/lib/status-style";

interface Item {
  name: string;
  executions: number;
  passed: number;
}

interface Props {
  items: Item[];
  isLoading: boolean;
}

const LABEL_CLS =
  "text-xs font-medium uppercase tracking-wider font-mono text-fg-muted";

export function TopFragileTests({ items, isLoading }: Props) {
  if (isLoading) {
    return (
      <Table bare>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-6 w-full" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (items.length === 0) {
    return <EmptyState title="No test data in this window." />;
  }

  return (
    <Table bare>
      <TableHeader>
        <tr>
          <TableHead className={LABEL_CLS}>#</TableHead>
          <TableHead className={LABEL_CLS}>Name</TableHead>
          <TableHead className={`${LABEL_CLS} text-right`}>
            Executions
          </TableHead>
          <TableHead className={`${LABEL_CLS} text-right`}>Passed</TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {items.map((it, idx) => {
          const pct =
            it.executions > 0
              ? Math.round((it.passed / it.executions) * 100)
              : 0;
          return (
            <TableRow key={it.name}>
              <TableCell className="tabular-nums text-fg-muted">
                {idx + 1}
              </TableCell>
              <TableCell>
                <span className="font-medium text-fg">{it.name}</span>
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {it.executions}
              </TableCell>
              <TableCell className="text-right">
                <span
                  className={`font-mono tabular-nums ${
                    pct === 100
                      ? statusStyle("passed").text
                      : pct === 0
                        ? statusStyle("failed").text
                        : statusStyle("unresolved").text
                  }`}
                >
                  {pct}%
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
