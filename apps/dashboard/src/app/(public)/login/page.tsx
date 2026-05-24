"use client";

import { useActionState } from "react";

import { loginAction } from "./action";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, undefined);
  return (
    <main className="flex min-h-screen items-center justify-center bg-black p-4">
      <Card className="w-full max-w-sm space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-brand rounded-sm rotate-12 flex items-center justify-center">
            <div className="w-1.5 h-1.5 bg-black rounded-full" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-white">
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
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
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
