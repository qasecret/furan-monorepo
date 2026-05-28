import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Variant = "default" | "secondary" | "destructive" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const variantClasses: Record<Variant, string> = {
  default: "bg-brand text-black hover:bg-brand/90",
  secondary:
    "border border-zinc-200 text-zinc-700 hover:text-zinc-950 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:text-white dark:hover:bg-zinc-900",
  destructive:
    "border border-red-300 bg-red-100 text-red-700 hover:bg-red-200 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20",
  ghost:
    "text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100/60 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-900/50",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950 disabled:opacity-50 disabled:pointer-events-none",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";
