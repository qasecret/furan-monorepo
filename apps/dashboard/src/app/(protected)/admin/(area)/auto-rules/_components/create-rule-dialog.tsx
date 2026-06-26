"use client";

import { zodResolver } from "@hookform/resolvers/zod";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";

const schema = z.object({
  label: z.string().min(1, "Label is required").max(200),
  selector: z.string().min(1, "CSS selector is required"),
  maxDiff: z.coerce.number().min(0).max(100).optional(),
  action: z.enum(["auto_approve", "flag"]),
});

type FormValues = z.infer<typeof schema>;

export function CreateRuleDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { action: "auto_approve" },
  });

  const create = trpc.autoRules.create.useMutation({
    onSuccess: () => {
      toast.success("Auto rule created");
      form.reset();
      setOpen(false);
      onCreated?.();
    },
    onError: (e) => toast.error(e.message || "Failed to create rule"),
  });

  const onSubmit = (values: FormValues) => {
    create.mutate({
      projectId,
      label: values.label,
      match: { type: "selector" as const, value: values.selector },
      conditions:
        values.maxDiff !== undefined ? { maxDiff: values.maxDiff } : null,
      action: values.action,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="create-rule-button">Create rule</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create auto rule</DialogTitle>
          <DialogDescription>
            Auto rules resolve known UI changes during diff evaluation.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Ignore timestamps" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="selector"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>CSS Selector</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. .timestamp, [data-time]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="maxDiff"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max diff % (optional)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      placeholder="Leave empty for any diff"
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="action"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Action</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="auto_approve">Auto Approve</SelectItem>
                      <SelectItem value="flag">Flag for Review</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
