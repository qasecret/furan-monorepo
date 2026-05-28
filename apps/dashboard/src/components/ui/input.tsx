import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-950 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:border-zinc-300 focus-visible:ring-1 focus-visible:ring-brand disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:placeholder:text-zinc-400 dark:focus-visible:border-zinc-700",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
