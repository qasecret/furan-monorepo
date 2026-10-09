import { cn } from "@/lib/cn";

/**
 * Furan logo lockup — the rotated neon square + black dot (matching
 * `app/icon.svg`) followed by the wordmark. Reused across the landing nav,
 * footer, and login so the brand mark stays identical everywhere.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="flex h-6 w-6 rotate-12 items-center justify-center rounded-[5px] bg-brand shadow-[0_0_18px_-2px_rgba(168,255,83,0.55)]">
        <span className="h-2 w-2 rounded-full bg-brand-fg" />
      </span>
      <span className="text-xl font-semibold tracking-tight text-fg">
        Furan
      </span>
    </span>
  );
}
