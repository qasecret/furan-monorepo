"use client";

import { ArrowRight, Check, Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import { loginAction } from "./action";

// Note: client components can't export `metadata`. The page-level
// document title is set by the public-segment layout instead — see
// app/(public)/layout.tsx.

import { BrandMark } from "@/components/landing/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const SHOWCASE_POINTS = [
  "Image-first pixel diffing",
  "VLM root-cause analysis",
  "Built-in axe accessibility",
];

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, undefined);
  const [showPassword, setShowPassword] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  // `autoFocus` fires only on mount; after a failed submit useActionState
  // re-renders the same inputs (no remount), so move focus to the password
  // field explicitly whenever the server action returns an error.
  useEffect(() => {
    if (state?.error) passwordRef.current?.focus();
  }, [state]);

  return (
    <main className="grid h-dvh grid-cols-1 overflow-y-auto bg-canvas lg:grid-cols-2">
      {/* ── Form column ───────────────────────────────────────────── */}
      <div className="relative flex min-h-dvh flex-col px-6 py-8 sm:px-10">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="rounded-md transition-opacity hover:opacity-80 focus-ring"
          >
            <BrandMark />
          </Link>
          <ThemeToggle />
        </div>

        <div className="flex flex-1 flex-col items-center py-10">
          <div className="my-auto w-full max-w-sm animate-[content-fade-up_500ms_var(--ease-out)_both]">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">
              Sign in to Furan
            </h1>
            <p className="mt-2 text-sm text-fg-secondary">
              Welcome back. Enter your credentials to access your workspace.
            </p>

            <form action={formAction} className="mt-8 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@company.com"
                  defaultValue={state?.email ?? ""}
                  autoFocus={!state?.email}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <span className="text-xs text-fg-muted">
                    Forgot? Contact your admin
                  </span>
                </div>
                <div className="relative">
                  <Input
                    ref={passwordRef}
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    required
                    autoComplete="current-password"
                    className="h-11 pr-10"
                  />
                  {/*
                    Eye toggle: clicking shows the plaintext so the user can
                    catch typos / caps-lock issues. tabIndex={-1} keeps the
                    toggle out of the tab order between the password field and
                    the submit button (GitHub / Stripe / Linear pattern).
                  */}
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    tabIndex={-1}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-muted transition-colors hover:text-fg"
                    data-testid="password-visibility-toggle"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
              {state?.error && (
                <p
                  className="flex items-center gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  {state.error === "invalid_credentials"
                    ? "Invalid email or password."
                    : "Invalid input."}
                </p>
              )}
              <Button
                type="submit"
                variant="glow"
                className="h-11 w-full text-base"
                disabled={pending}
              >
                {pending ? (
                  "Signing in..."
                ) : (
                  <>
                    Sign in <ArrowRight className="ml-1 h-4 w-4" />
                  </>
                )}
              </Button>
            </form>

            <p className="mt-8 text-center text-xs text-fg-muted">
              Self-hosted · Your data never leaves your infrastructure
            </p>
          </div>
        </div>
      </div>

      {/* ── Brand showcase column (desktop) — purely decorative ─────
          marketing motif, hidden from assistive tech (the sign-in form is
          the actual content); scrolls instead of clipping on short windows. */}
      <aside
        aria-hidden="true"
        className="relative hidden overflow-x-hidden overflow-y-auto border-l border-edge bg-gradient-to-br from-sunken to-canvas lg:flex lg:flex-col"
      >
        <div className="bg-dotgrid pointer-events-none absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_70%_60%_at_65%_35%,#000,transparent)]" />
        <div className="pointer-events-none absolute -right-24 top-8 h-[420px] w-[420px] rounded-full bg-[var(--furan-glow)] blur-[120px]" />

        <div className="relative z-10 mx-auto my-auto max-w-md px-12 py-12">
          <span className="inline-flex items-center gap-2 rounded-full border border-edge bg-raised/70 px-3 py-1 text-xs font-medium text-brand-text backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            Self-hosted visual QA
          </span>
          <h2 className="mt-6 text-3xl font-semibold leading-tight tracking-tight text-fg">
            Visual testing that explains itself.
          </h2>
          <p className="mt-4 text-fg-secondary">
            Pixel-perfect diffs, a VLM smart layer that tells you what changed
            and why, and accessibility checks — on infrastructure you control.
          </p>

          {/* compact diff motif */}
          <div className="mt-10 rounded-2xl bg-raised/80 p-4 shadow-raised backdrop-blur">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-mono text-2xs uppercase tracking-wider text-fg-muted">
                build #1284 · main
              </span>
              <span className="rounded bg-brand/15 px-1.5 py-0.5 text-2xs font-bold uppercase text-brand-text">
                Approved
              </span>
            </div>
            <div className="space-y-2">
              <div className="h-2.5 w-3/4 rounded-full bg-edge" />
              <div className="relative">
                <div className="h-9 w-40 rounded-md bg-brand/80" />
                <span className="absolute -top-2 left-36 rounded bg-brand-fg px-1.5 py-0.5 text-2xs font-bold text-brand">
                  diff
                </span>
              </div>
              <div className="h-2.5 w-2/3 rounded-full bg-edge" />
            </div>
          </div>

          <ul className="mt-8 space-y-3 text-sm">
            {SHOWCASE_POINTS.map((point) => (
              <li
                key={point}
                className="flex items-center gap-3 text-fg-secondary"
              >
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand/15">
                  <Check className="h-3 w-3 text-brand-text" />
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </main>
  );
}
