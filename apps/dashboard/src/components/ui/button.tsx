import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Variant = "default" | "glow" | "secondary" | "destructive" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Render as the single child element (Radix Slot) — e.g. style a <Link>. */
  asChild?: boolean;
}

const variantClasses: Record<Variant, string> = {
  default: "bg-brand text-brand-fg shadow-brand-edge hover:bg-brand/90",
  // Primary CTA with the neon brand glow (landing hero / final CTA / login).
  // The base class already transitions box-shadow.
  glow: "bg-brand text-brand-fg hover:bg-brand/90 shadow-[0_8px_30px_-10px_rgba(168,255,83,0.7)] hover:shadow-[0_12px_40px_-8px_rgba(168,255,83,0.75)]",
  secondary:
    "bg-raised text-fg-secondary shadow-raised hover:bg-hover hover:text-fg",
  destructive:
    "border border-status-failed/25 bg-status-failed/10 text-status-failed-text hover:bg-status-failed/15",
  ghost: "text-fg-secondary hover:bg-hover hover:text-fg",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-[color,background-color,border-color,transform,box-shadow] duration-150 ease-out active:scale-[0.97] focus-ring disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100",
          variantClasses[variant],
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
