"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

interface Props {
  value: string;
  /** What the value is ("API URL"): names the button and the announcement. */
  label: string;
  "data-testid"?: string;
}

/**
 * A value in the data face with a Copy button. Copied shows for 2 s and is
 * announced. A refused write, or a page with no clipboard API at all (plain
 * http on anything but localhost is not a secure context), toasts and leaves
 * the value on screen to select by hand.
 */
export function CopyField({ value, label, "data-testid": testId }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error("Copy failed — select the text manually");
    }
  };

  return (
    <div className="flex items-start gap-2" data-testid={testId}>
      <code className="min-w-0 flex-1 break-all rounded-md border border-edge bg-sunken px-2 py-1 font-mono text-xs text-fg">
        {value}
      </code>
      <Button
        type="button"
        variant="secondary"
        className="h-7 shrink-0 px-2 text-xs"
        aria-label={`Copy ${label}`}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="mr-1 h-3.5 w-3.5" aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} copied` : ""}
      </span>
    </div>
  );
}
