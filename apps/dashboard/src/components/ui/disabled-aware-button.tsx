"use client";

import { useId, type MouseEvent, type ReactNode } from "react";

import { Button, type ButtonProps } from "./button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

export interface DisabledAwareButtonProps {
  disabled: boolean;
  /** Why the button is disabled; without one, a disabled button just is. */
  reason: string | null;
  /**
   * Test id of the button. A disabled button with a reason also gets
   * `${testId}-disabled-wrapper` and `${testId}-disabled-reason`.
   */
  testId: string;
  variant: NonNullable<ButtonProps["variant"]>;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  title?: string;
  className?: string;
  /** The accessible name, for a button that holds only an icon. */
  label?: string;
}

/**
 * A button whose disabled state explains itself (spec §3.5): a reviewer should
 * see *why* an action is unavailable, not have the control vanish.
 *
 * A disabled `<button>` can be neither focused nor hovered (the browser
 * swallows the events), so a disabled button with a reason sits in a focusable
 * wrapper that opens the tooltip on hover and on focus. The wrapper is a
 * disabled button to assistive technology, named like the button, and
 * described by the reason (also present as hidden text, so it is read whether
 * or not the tooltip has opened). An enabled button, or a disabled one with no
 * reason to give, is a plain button.
 */
export function DisabledAwareButton({
  disabled,
  reason,
  testId,
  variant,
  onClick,
  children,
  title,
  className,
  label,
}: DisabledAwareButtonProps) {
  const reasonId = useId();
  const button = (
    <Button
      type="button"
      variant={variant}
      className={className}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={title}
      aria-label={label}
    >
      {children}
    </Button>
  );
  if (!disabled || !reason) return button;
  return (
    <>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              role="button"
              aria-disabled="true"
              aria-label={label}
              aria-describedby={reasonId}
              data-testid={`${testId}-disabled-wrapper`}
              className="inline-flex rounded-md focus-ring"
            >
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent
            sideOffset={4}
            data-testid={`${testId}-disabled-reason`}
          >
            {reason}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span id={reasonId} className="sr-only">
        {reason}
      </span>
    </>
  );
}
