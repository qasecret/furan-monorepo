"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { Sidebar } from "./sidebar";
import { useMobileSidebarStore } from "./use-mobile-sidebar";

interface Props {
  userRole: "admin" | "editor" | "guest";
  userEmail: string;
  userInitial: string;
}

/**
 * Mobile drawer that wraps the desktop `<Sidebar>` in a Radix Dialog so it
 * slides in from the left on `<md` viewports. The hamburger trigger lives in
 * `<TopBar>` (gated `md:hidden`); this component owns the drawer surface +
 * overlay + scroll-lock + focus-trap via Radix.
 *
 * Auto-closes on pathname change so tapping a nav link inside the drawer
 * dismisses it (the underlying `<SidebarNavItem>` doesn't need to know
 * anything about the drawer).
 *
 * Rendered at the AppShell level alongside the desktop sidebar; the
 * desktop sidebar carries `hidden md:flex` so only one is visible per
 * breakpoint.
 */
export function MobileSidebar({ userRole, userEmail, userInitial }: Props) {
  const open = useMobileSidebarStore((s) => s.open);
  const setOpen = useMobileSidebarStore((s) => s.setOpen);
  const pathname = usePathname();

  // Auto-dismiss on route change. The effect also fires on mount with the
  // initial pathname; the setOpen(false) is idempotent there so it's safe.
  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 md:hidden"
          data-testid="mobile-sidebar-overlay"
        />
        <DialogPrimitive.Content
          className="fixed inset-y-0 left-0 z-50 w-60 bg-zinc-950 border-r border-zinc-800 flex flex-col shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left md:hidden"
          data-testid="mobile-sidebar"
        >
          <DialogPrimitive.Title className="sr-only">
            Navigation
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Sidebar navigation: workspace, account, and admin sections.
          </DialogPrimitive.Description>
          <DialogPrimitive.Close
            className="absolute right-3 top-3 z-10 rounded-md p-1 text-zinc-400 hover:text-white hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
            data-testid="mobile-sidebar-close"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </DialogPrimitive.Close>
          {/* The Sidebar component carries its own `w-60 border-r bg-zinc-950`
              styling; inside the drawer those are redundant but harmless.
              Wrapping it keeps the desktop + mobile DOM identical so future
              Sidebar edits don't need to fork. */}
          <Sidebar
            userRole={userRole}
            userEmail={userEmail}
            userInitial={userInitial}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
