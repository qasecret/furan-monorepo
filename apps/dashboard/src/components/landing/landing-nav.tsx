"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { BrandMark } from "./brand-mark";
import { GITHUB_URL } from "./constants";
import { GithubIcon } from "./github-icon";

import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#preview", label: "Product" },
  { href: "#sdk", label: "SDK" },
];

export function LandingNav() {
  const [open, setOpen] = useState(false);

  // Close the mobile menu on Escape — a keyboard dismiss affordance for the
  // open dropdown, which otherwise has no close key.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-edge/70 bg-canvas/70 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="rounded-md transition-opacity hover:opacity-80 focus-ring"
          >
            <BrandMark />
          </Link>
          <div className="hidden items-center gap-6 text-sm text-fg-secondary md:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="rounded-sm transition-colors hover:text-fg focus-ring"
              >
                {l.label}
              </a>
            ))}
          </div>
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-edge bg-raised/60 px-3 py-1.5 text-sm text-fg-secondary transition-colors hover:text-fg focus-ring"
          >
            <GithubIcon className="h-4 w-4" />
            <span className="font-medium">GitHub</span>
          </a>
          <ThemeToggle />
          <Button asChild variant="ghost" className="h-9">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button
            asChild
            className="h-9 transition-shadow hover:shadow-[0_8px_30px_-8px_rgba(168,255,83,0.6)]"
          >
            <Link href="/home">Open dashboard</Link>
          </Button>
        </div>

        <div className="flex items-center gap-1 md:hidden">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-secondary transition-colors hover:text-fg focus-ring"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {open && (
        <div className="border-t border-edge/70 bg-canvas/95 px-4 py-4 backdrop-blur-xl md:hidden">
          <div className="flex flex-col gap-1">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-fg-secondary transition-colors hover:bg-hover hover:text-fg focus-ring"
              >
                {l.label}
              </a>
            ))}
            <div className="mt-3 flex flex-col gap-2">
              <Button asChild variant="secondary" className="w-full">
                <Link href="/login" onClick={() => setOpen(false)}>
                  Sign in
                </Link>
              </Button>
              <Button asChild className="w-full">
                <Link href="/home" onClick={() => setOpen(false)}>
                  Open dashboard
                </Link>
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
