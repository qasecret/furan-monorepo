"use client";

import { Eye, EyeOff } from "lucide-react";
import { useActionState, useState } from "react";

import { loginAction } from "./action";

// Note: client components can't export `metadata`. The page-level
// document title is set by the public-segment layout instead — see
// app/(public)/layout.tsx.

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, undefined);
  const [showPassword, setShowPassword] = useState(false);
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black p-4">
      <Card className="w-full max-w-sm space-y-4 animate-[content-fade-up_400ms_cubic-bezier(0.23,1,0.32,1)_both]">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-brand rounded-sm rotate-12 flex items-center justify-center">
            <div className="w-1.5 h-1.5 bg-black rounded-full" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">
            Sign in to Furan
          </h1>
        </div>
        <form action={formAction} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              defaultValue={state?.email ?? ""}
              autoFocus={!state?.email}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                autoFocus={!!state?.email}
                className="pr-10"
              />
              {/*
                Eye toggle: clicking shows the plaintext so the user can
                catch typos / caps-lock issues. We intentionally do NOT
                add `data-testid="password-toggle"` until there is a test
                that consumes it — keeps the surface clean.

                tabIndex={-1} so the toggle isn't in the tab order between
                the password field and the submit button. Standard pattern
                from GitHub / Stripe / Linear logins — keyboard users
                press Tab once to reach Sign in, not twice.
              */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={-1}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-600 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors"
                data-testid="password-visibility-toggle"
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
          {state?.error && (
            <p className="text-sm text-red-400" role="alert">
              {state.error === "invalid_credentials"
                ? "Invalid email or password."
                : "Invalid input."}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
