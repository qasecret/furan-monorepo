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
  "text-xs font-medium uppercase tracking-wider font-mono text-zinc-500 dark:text-zinc-400";

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
              <TableCell className="tabular-nums text-zinc-500">
                {idx + 1}
              </TableCell>
              <TableCell>
                <span className="font-medium text-zinc-950 dark:text-white">
                  {it.name}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {it.executions}
              </TableCell>
              <TableCell className="text-right">
                <span
                  className={
                    pct === 100
                      ? "tabular-nums text-emerald-600 dark:text-emerald-400"
                      : pct === 0
                        ? "tabular-nums text-red-600 dark:text-red-400"
                        : "tabular-nums text-amber-600 dark:text-amber-400"
                  }
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
