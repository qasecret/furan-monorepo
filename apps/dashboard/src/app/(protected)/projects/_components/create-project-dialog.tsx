"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { browserEnv } from "@/lib/env";

const schema = z.object({
  name: z.string().min(1, "Required").max(120, "Too long (max 120 chars)"),
  mainBranchName: z
    .string()
    .max(120, "Too long (max 120 chars)")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
});

type FormValues = z.infer<typeof schema>;

/**
 * Admin-only dialog for creating a project from the dashboard. Mirrors the
 * CreateUserDialog / CreateTokenDialog pattern: shadcn Dialog + react-hook-form
 * + zod + REST fetch. 409 surfaces as an inline name-field error so the user
 * can rename without losing context.
 *
 * On 201 we router.push(`/projects/<id>`) so the new project's settings page
 * is the next surface — that's where the user mints a PAT and configures the
 * SDK.
 */
export function CreateProjectDialog({
  open: openProp,
  onOpenChange,
  hideTrigger = false,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
} = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const router = useRouter();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", mainBranchName: "" },
  });

  const onSubmit = async (values: FormValues): Promise<void> => {
    const requestBody: Record<string, string> = { name: values.name };
    if (values.mainBranchName)
      requestBody.mainBranchName = values.mainBranchName;
    let res: Response;
    try {
      res = await fetch(`${browserEnv.NEXT_PUBLIC_API_URL}/projects`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch {
      // Network-level failure (CORS, DNS, offline) — surface a toast so the
      // dialog doesn't appear to hang silently after the spinner clears.
      toast.error("Could not reach the API. Check NEXT_PUBLIC_API_URL.");
      return;
    }
    if (res.status === 409) {
      form.setError("name", {
        message: "A project with this name already exists",
      });
      return;
    }
    if (res.status === 403) {
      toast.error("Only admins can create projects");
      return;
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as {
        code?: string;
      };
      toast.error(payload?.code ?? "Failed to create project");
      return;
    }
    const project = (await res.json()) as { id: string };
    form.reset();
    setOpen(false);
    router.push(`/projects/${project.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button data-testid="create-project-button">Create project</Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            Pick a name and the default branch. You can change everything else
            from project Settings.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            data-testid="create-project-form"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. my-app"
                      {...field}
                      data-testid="project-name-input"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="mainBranchName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Main branch</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="main"
                      {...field}
                      value={field.value ?? ""}
                      data-testid="project-branch-input"
                    />
                  </FormControl>
                  <FormDescription>
                    Optional — defaults to <code>main</code>.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="submit"
                disabled={form.formState.isSubmitting}
                data-testid="submit-create-project"
              >
                {form.formState.isSubmitting ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
