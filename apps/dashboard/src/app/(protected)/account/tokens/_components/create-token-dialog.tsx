"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import {
  expiry,
  FALLBACK_TOKEN_POLICY,
  lifetimeLabel,
  projectLabel,
  scopeLabel,
  type ProjectOption,
  type TokenPolicy,
} from "./token-grant";
import { TokenNextStep } from "./token-next-step";

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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { browserEnv } from "@/lib/env";

/** The project choice that leaves the token unbound. */
const ALL_PROJECTS = "all";
/** The lifetime choice for a token that never expires (operator cap 0). */
const NO_EXPIRY = "never";

const schema = z.object({
  label: z.string().min(1, "Label is required").max(80, "Label too long"),
  scope: z.enum(["sdk", "read"]),
  projectId: z.string().min(1),
  lifetime: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

interface CreatedToken {
  token: string;
  scopes: Array<"legacy" | "sdk" | "read">;
  projectId: string | null;
  expiresAt: string | null;
}

interface CreateTokenDialogProps {
  /** Projects the token can be bound to; the first is preselected. */
  projects?: ProjectOption[];
  /** What the operator allows; defaults to the api's own defaults. */
  policy?: TokenPolicy;
  onCreated?: () => void;
  children?: React.ReactNode;
}

/**
 * Two-phase dialog for creating an API token.
 *
 * Phase 1: user types a label and picks what the token may do (ADR-064 step
 *   B): its scope (`sdk` by default), a project (the first one preselected;
 *   "All my projects" leaves it unbound) and a lifetime (the operator's
 *   default) → POST /account/tokens.
 * Phase 2: shows the raw `furan_pat_*` value EXACTLY ONCE, with copy-to-
 *   clipboard. Dismissal is gated by an "I've stored this token securely"
 *   checkbox. While in phase 2, the dialog refuses to close via overlay /
 *   escape clicks unless acknowledged, so the user cannot accidentally lose
 *   the token without confirming they've saved it.
 *
 * Security invariants:
 *  - The raw token lives ONLY in component state (`created`).
 *  - On close, `created` is cleared. No setItem to localStorage or
 *    sessionStorage anywhere in this file — a dedicated test enforces this.
 */
export function CreateTokenDialog({
  projects = [],
  policy = FALLBACK_TOKEN_POLICY,
  onCreated,
  children,
}: CreateTokenDialogProps) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      label: "",
      scope: "sdk",
      projectId: projects[0]?.id ?? ALL_PROJECTS,
      lifetime: String(policy.defaultLifetimeDays),
    },
  });
  const rawToken = created?.token ?? null;

  const resetAll = (): void => {
    setCreated(null);
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
        body: JSON.stringify({
          label: values.label,
          scopes: [values.scope],
          projectId:
            values.projectId === ALL_PROJECTS ? null : values.projectId,
          expiresInDays:
            values.lifetime === NO_EXPIRY ? null : Number(values.lifetime),
        }),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      toast.error(body?.message ?? body?.code ?? "Failed to create token");
      return;
    }
    const data = (await res.json()) as Partial<CreatedToken>;
    if (!data?.token) {
      toast.error(
        "Token created but raw value missing — please contact support",
      );
      return;
    }
    setCreated({
      token: data.token,
      scopes: data.scopes ?? [values.scope],
      projectId: data.projectId ?? null,
      expiresAt: data.expiresAt ?? null,
    });
  };

  const createdSummary = (c: CreatedToken): string => {
    const projectName =
      projects.find((p) => p.id === c.projectId)?.name ?? null;
    return [
      scopeLabel(c.scopes),
      projectLabel({ projectId: c.projectId, projectName }),
      expiry(c.expiresAt).label,
    ].join(" · ");
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
        {children ?? (
          <Button data-testid="create-token-button">Create token</Button>
        )}
      </DialogTrigger>
      <DialogContent>
        {rawToken === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Create API token</DialogTitle>
              <DialogDescription>
                Give the token only what this CI job needs. You can&apos;t
                change it later; create a new one instead.
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
                <FormField
                  control={form.control}
                  name="scope"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Access</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="scope-trigger">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="sdk">
                            SDK &amp; CI: upload runs and read results
                          </SelectItem>
                          <SelectItem value="read">
                            Read-only: read projects, builds and runs
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        An SDK token can save the first baseline of a new test,
                        but never approves a change; that stays with a reviewer.
                      </FormDescription>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="projectId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="project-trigger">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {projects.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                          <SelectItem value={ALL_PROJECTS}>
                            All my projects
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        &ldquo;All my projects&rdquo; covers the projects
                        you&apos;re a member of, now and later.
                      </FormDescription>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="lifetime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Expires after</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="lifetime-trigger">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {policy.lifetimeDays.map((days) => (
                            <SelectItem key={days} value={String(days)}>
                              {lifetimeLabel(days)}
                            </SelectItem>
                          ))}
                          {policy.allowNoExpiry && (
                            <SelectItem value={NO_EXPIRY}>Never</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
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
              {created && (
                <p
                  className="text-xs text-fg-muted"
                  data-testid="created-token-summary"
                >
                  {createdSummary(created)}
                </p>
              )}
              <div className="flex items-stretch gap-2">
                <code
                  aria-label="API token"
                  className="flex-1 rounded-md border border-edge bg-sunken text-fg px-3 py-2 font-mono text-xs break-all"
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
              <TokenNextStep />
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
