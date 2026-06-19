import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";

/**
 * Shared table shell — lifts the card-wrapped, zinc-styled `<table>` that the
 * admin/account tables all repeated, so they stay visually identical. Consumers
 * supply their own columns via TableHead/TableCell. Note: the header row is a
 * bare `<tr>` inside TableHeader (no hover); body rows use TableRow (hover).
 */
export function Table({
  className,
  children,
  ...props
}: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="overflow-x-auto">
        <table className={cn("w-full text-sm", className)} {...props}>
          {children}
        </table>
      </div>
    </div>
  );
}

export function TableHeader({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        "border-b border-zinc-200 bg-zinc-100/70 text-left text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400",
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn("px-4 py-2.5 font-medium", className)} {...props} />;
}

export function TableBody({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn("divide-y divide-zinc-200 dark:divide-zinc-800", className)}
      {...props}
    />
  );
}

export function TableRow({
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "transition-colors hover:bg-zinc-100/60 dark:hover:bg-zinc-900/30",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-2.5", className)} {...props} />;
}

/** A full-width zero-data row. `colSpan` must equal the table's column count. */
export function TableEmpty({
  colSpan,
  className,
  children,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className={cn(
          "px-4 py-8 text-center text-zinc-500 dark:text-zinc-500",
          className,
        )}
        {...props}
      >
        {children}
      </td>
    </tr>
  );
}
