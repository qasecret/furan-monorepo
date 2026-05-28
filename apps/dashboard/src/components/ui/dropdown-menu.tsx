"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as React from "react";

import { cn } from "@/lib/cn";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[8rem] overflow-hidden rounded-md border border-zinc-200 bg-white p-1 text-zinc-800 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100",
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm text-zinc-700 outline-none data-[highlighted]:bg-zinc-100 data-[highlighted]:text-zinc-950 dark:text-zinc-300 dark:data-[highlighted]:bg-zinc-900 dark:data-[highlighted]:text-white",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

/**
 * shadcn-style multi-select primitive — pairs with the Radix
 * `<DropdownMenu>` to give a checkable list where multiple items can
 * stay selected. Used by the runs-list status filter (spec §3.5).
 *
 * `onSelect={(e) => e.preventDefault()}` keeps the menu open after a
 * tick so reviewers can flip several statuses in one trip instead of
 * re-opening the menu per toggle.
 */
const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-zinc-700 outline-none data-[highlighted]:bg-zinc-100 data-[highlighted]:text-zinc-950 dark:text-zinc-300 dark:data-[highlighted]:bg-zinc-900 dark:data-[highlighted]:text-white",
      className,
    )}
    checked={checked}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center text-brand">
      <DropdownMenuPrimitive.ItemIndicator>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="h-3.5 w-3.5"
        >
          <path
            fillRule="evenodd"
            d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 011.414-1.42L8.5 12.09l6.793-6.8a1 1 0 011.41 0z"
            clipRule="evenodd"
          />
        </svg>
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName;

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
};
