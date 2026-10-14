"use client";

import { forwardRef, useId, type MouseEvent, type ReactNode } from "react";

import { Button, type ButtonProps } from "./button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

import { cn } from "@/lib/cn";

/**
 * What each variant looks like at rest, spelled as `aria-disabled:hover:`
 * utilities. An unavailable button is left hoverable (it must be, to show its
 * reason), and the variant's own hover colours would make it look pressable.
 * These win over them on specificity, whatever the order, and only while the
 * button is `aria-disabled`. A caller that restyles a variant's rest or hover
 * restyles these the same way (`cn` merges them like any other modifier set).
 * Every class is a full literal string so Tailwind can see it.
 */
const RESTING_WHILE_UNAVAILABLE: Record<
  NonNullable<ButtonProps["variant"]>,
  string
> = {
  default: "aria-disabled:hover:bg-brand",
  glow: "aria-disabled:hover:bg-brand",
  secondary:
    "aria-disabled:hover:bg-raised aria-disabled:hover:text-fg-secondary",
  destructive: "aria-disabled:hover:bg-status-failed/10",
  ghost:
    "aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg-secondary",
};

export interface DisabledAwareButtonProps {
  disabled: boolean;
  /** Why the button is disabled; without one, a disabled button just is. */
  reason: string | null;
  /** Test id of the button. A disabled button's reason is `${testId}-disabled-reason`. */
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
 * A natively `disabled` button can be neither focused nor hovered, so it can
 * show no reason. A disabled button *with* a reason is therefore left
 * focusable and marked `aria-disabled` instead: still one control, one tab
 * stop, announced as unavailable and described by the reason, with a tooltip
 * for hover and focus. Its click does nothing, and it does not react to hover
 * as a pressable control would. The reason is hidden text that
 * `aria-describedby` still reads, so it is not read a second time in place.
 * A disabled button with no reason to give is a plain native `disabled` one.
 *
 * The button is the same element in every state, so it keeps focus as it
 * becomes unavailable (the last pending step was just approved).
 */
export const DisabledAwareButton = forwardRef<
  HTMLButtonElement,
  DisabledAwareButtonProps
>(function DisabledAwareButton(
  {
    disabled,
    reason,
    testId,
    variant,
    onClick,
    children,
    title,
    className,
    label,
  },
  ref,
) {
  const reasonId = useId();
  // Unavailable, and able to say why.
  const explained = disabled && !!reason;
  return (
    // The same tree whatever the state, so the button is never remounted.
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant={variant}
            className={cn(
              // No press, no pointer: it is unavailable, not just quiet.
              "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:scale-100",
              RESTING_WHILE_UNAVAILABLE[variant],
              className,
            )}
            // Natively disabled only when there is nothing to explain.
            disabled={disabled && !explained}
            aria-disabled={explained ? true : undefined}
            aria-describedby={explained ? reasonId : undefined}
            aria-label={label}
            // The tooltip replaces a native title on an explained button.
            title={explained ? undefined : title}
            data-testid={testId}
            onClick={(event) => {
              if (explained) return;
              onClick(event);
            }}
          >
            {children}
          </Button>
        </TooltipTrigger>
        {explained && (
          <TooltipContent
            sideOffset={4}
            data-testid={`${testId}-disabled-reason`}
          >
            {reason}
          </TooltipContent>
        )}
      </Tooltip>
      {explained && (
        <span id={reasonId} hidden>
          {reason}
        </span>
      )}
    </TooltipProvider>
  );
});
