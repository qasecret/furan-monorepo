import { cn } from "@/lib/cn";

type Size = "sm" | "md" | "lg";

const MARK: Record<Size, string> = {
  sm: "h-5 w-5",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};
const DOT: Record<Size, string> = {
  sm: "h-1.5 w-1.5",
  md: "h-2 w-2",
  lg: "h-2.5 w-2.5",
};
const TEXT: Record<Size, string> = {
  sm: "text-lg",
  md: "text-xl",
  lg: "text-2xl",
};

/**
 * Furan logo lockup — the rotated neon square + black dot (matching
 * `app/icon.svg`) followed by the wordmark. Reused across the landing nav,
 * footer, and login so the brand mark stays identical everywhere.
 */
export function BrandMark({
  className,
  wordmark = true,
  size = "md",
}: {
  className?: string;
  wordmark?: boolean;
  size?: Size;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className={cn(
          "flex rotate-12 items-center justify-center rounded-[5px] bg-brand shadow-[0_0_18px_-2px_rgba(168,255,83,0.55)]",
          MARK[size],
        )}
      >
        <span className={cn("rounded-full bg-black", DOT[size])} />
      </span>
      {wordmark && (
        <span
          className={cn(
            "font-semibold tracking-tight text-zinc-950 dark:text-white",
            TEXT[size],
          )}
        >
          Furan
        </span>
      )}
    </span>
  );
}
