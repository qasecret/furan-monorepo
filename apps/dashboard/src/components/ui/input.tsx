import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-md border border-edge bg-canvas px-3 py-2 text-sm text-fg transition-[border-color,box-shadow] duration-150 placeholder:text-fg-muted focus-ring disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
