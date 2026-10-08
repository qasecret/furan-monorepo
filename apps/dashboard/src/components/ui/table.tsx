import Link from "next/link";
import type {
  ComponentProps,
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";

/**
 * Shared table shell — the card-wrapped, token-styled `<table>` every admin /
 * account / list page renders into, so they stay visually identical. Consumers
 * supply columns via TableHead/TableCell. The header row is a bare `<tr>` inside
 * TableHeader (no hover); body rows use TableRow (hover + `group`, so a primary
 * cell link can light up on row-hover via TableLink / `group-hover:text-brand-text`).
 */
export function Table({
  className,
  bare,
  children,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { bare?: boolean }) {
  const table = (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-sm", className)} {...props}>
        {children}
      </table>
    </div>
  );
  if (bare) return table;
  return (
    <div className="overflow-hidden rounded-lg bg-raised shadow-raised">
      {table}
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
        "border-b border-edge bg-sunken text-left text-2xs font-medium uppercase tracking-wide text-fg-muted",
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
  return <th className={cn("px-5 py-3 font-medium", className)} {...props} />;
}

export function TableBody({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn("divide-y divide-edge-subtle", className)}
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
        "group border-edge-subtle transition-colors hover:bg-hover",
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
  return <td className={cn("px-5 py-3 align-middle", className)} {...props} />;
}

/**
 * Primary-cell link that goes neon on row-hover (matches the reference's batch
 * rows). Use inside a TableRow (which supplies the `group`).
 */
export function TableLink({
  className,
  ...props
}: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "font-medium text-fg transition-colors group-hover:text-brand-text",
        className,
      )}
      {...props}
    />
  );
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
        className={cn("px-5 py-10 text-center text-fg-muted", className)}
        {...props}
      >
        {children}
      </td>
    </tr>
  );
}
