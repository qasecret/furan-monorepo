"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { browserEnv } from "@/lib/env";

const schema = z.object({
  label: z.string().min(1, "Label is required").max(80, "Label too long"),
});

type FormValues = z.infer<typeof schema>;

interface CreateTokenDialogProps {
  onCreated?: () => void;
}

/**
 * Two-phase dialog for creating a personal access token.
 *
 * Phase 1: user types a label → POST /account/tokens.
 * Phase 2: shows the raw `furan_pat_*` value EXACTLY ONCE, with copy-to-
 *   clipboard. Dismissal is gated by an "I've stored this token securely"
 *   checkbox. While in phase 2, the dialog refuses to close via overlay /
 *   escape clicks unless acknowledged, so the user cannot accidentally lose
 *   the token without confirming they've saved it.
 *
 * Security invariants:
 *  - The raw token lives ONLY in component state (`rawToken`).
 *  - On close, `rawToken` is cleared. No setItem to localStorage or
 *    sessionStorage anywhere in this file — a dedicated test enforces this.
 */
export function CreateTokenDialog({ onCreated }: CreateTokenDialogProps) {
  const [open, setOpen] = useState(false);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { label: "" },
  });

  const resetAll = (): void => {
    setRawToken(null);
    setAcknowledged(false);
    setCopied(false);
    form.reset();
  };

  // Block close-while-unacknowledged in phase 2 (overlay click / escape /
  // explicit X button) so the user cannot lose the token without confirming.
  const handleOpenChange = (next: boolean): void => {
    if (!next && rawToken !== null && !acknowledged) return;
    setOpen(next);
    if (!next) resetAll();
  };

  const onSubmit = async (values: FormValues): Promise<void> => {
    const res = await fetch(
      `${browserEnv.NEXT_PUBLIC_API_URL}/account/tokens`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: values.label }),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body?.error ?? "Failed to create token");
      return;
    }
    const data = (await res.json()) as { token?: string };
    if (!data?.token) {
      toast.error(
        "Token created but raw value missing — please contact support",
      );
      return;
    }
    setRawToken(data.token);
  };

  const handleCopy = async (): Promise<void> => {
    if (!rawToken) return;
    try {
      await navigator.clipboard.writeText(rawToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed — select the text manually");
    }
  };

  const handleDismiss = (): void => {
    setOpen(false);
    resetAll();
    onCreated?.();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button data-testid="create-token-button">Create token</Button>
      </DialogTrigger>
      <DialogContent>
        {rawToken === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Create personal access token</DialogTitle>
              <DialogDescription>
                Pick a label that describes where this token will be used.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-4"
                data-testid="create-token-form"
              >
                <FormField
                  control={form.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Label</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. CI — main"
                          {...field}
                          data-testid="label-input"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button
                    type="submit"
                    disabled={form.formState.isSubmitting}
                    data-testid="submit-create-token"
                  >
                    {form.formState.isSubmitting ? "Creating…" : "Create"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Copy your token</DialogTitle>
              <DialogDescription>
                This is the only time the token will be shown. Store it
                somewhere safe — typically a CI secrets manager.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-stretch gap-2">
                <code
                  aria-label="Personal access token"
                  className="flex-1 rounded-md border border-zinc-200 bg-zinc-50 text-zinc-800 px-3 py-2 font-mono text-xs break-all dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                  data-testid="raw-token-display"
                >
                  {rawToken}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleCopy()}
                  aria-label="Copy token to clipboard"
                  data-testid="copy-token-button"
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4 mr-1" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-1" /> Copy
                    </>
                  )}
                </Button>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  data-testid="acknowledge-checkbox"
                  className="mt-0.5"
                />
                <span>
                  I&apos;ve stored this token securely and understand it
                  won&apos;t be shown again.
                </span>
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                onClick={handleDismiss}
                disabled={!acknowledged}
                data-testid="close-token-dialog"
              >
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
