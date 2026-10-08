"use client";

import { ChevronDown } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/cn";

interface Props {
  title: ReactNode;
  /** Optional sub-title shown under the title in the header. */
  description?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

/**
 * Controlled, dependency-free collapsible section styled like a Card. The parent
 * owns `open` so it can force a section open (e.g. when it contains a validation
 * error). Header is a real <button> with aria-expanded/aria-controls.
 */
export function CollapsibleSection({
  title,
  description,
  open,
  onOpenChange,
  children,
  className,
}: Props) {
  const bodyId = useId();
  return (
    <div className={cn("rounded-xl bg-raised shadow-raised", className)}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        className="flex w-full items-center justify-between gap-2 px-6 py-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold text-fg">{title}</span>
          {description ? (
            <span className="mt-0.5 block text-sm text-fg-muted">
              {description}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-fg-muted transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div id={bodyId} className="border-t border-edge px-6 py-5">
          {children}
        </div>
      ) : null}
    </div>
  );
}
