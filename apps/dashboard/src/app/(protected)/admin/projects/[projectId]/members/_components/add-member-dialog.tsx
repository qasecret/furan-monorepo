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
import { trpc } from "@/lib/trpc";

const schema = z.object({
  email: z.string().email("Must be a valid email"),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  projectId: string;
}

export function AddMemberDialog({ projectId }: Props) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const add = trpc.members.add.useMutation({
    onSuccess: async () => {
      await utils.members.list.invalidate({ projectId });
      toast.success("Member added");
      form.reset();
      setOpen(false);
    },
    onError: (e: { message: string }) => {
      // Map known server error messages to inline form errors so the user
      // sees the issue next to the input rather than as a transient toast.
      if (e.message === "no_user_with_that_email") {
        form.setError("email", { message: "No user with that email" });
      } else if (e.message === "user_must_be_editor_role") {
        form.setError("email", {
          message: "User must have the 'editor' role to be added",
        });
      } else if (e.message === "already_a_member") {
        form.setError("email", { message: "Already a member of this project" });
      } else {
        toast.error(e.message || "Failed to add member");
      }
    },
  });

  const onSubmit = (values: FormValues): void => {
    add.mutate({ projectId, email: values.email });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="add-member-button">Add member</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            Add an existing editor user to this project by email.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            data-testid="add-member-form"
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      {...field}
                      data-testid="add-email-input"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="submit"
                disabled={add.isPending}
                data-testid="submit-add"
              >
                {add.isPending ? "Adding…" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
