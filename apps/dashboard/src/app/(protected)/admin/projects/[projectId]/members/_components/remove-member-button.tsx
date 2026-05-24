"use client";

import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  userId: string;
  email: string;
}

export function RemoveMemberButton({ projectId, userId, email }: Props) {
  const utils = trpc.useUtils();
  const remove = trpc.members.remove.useMutation({
    onSuccess: async () => {
      await utils.members.list.invalidate({ projectId });
      toast.success("Member removed");
    },
    onError: (e: { message: string }) => {
      toast.error(e.message || "Failed to remove member");
    },
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="secondary" data-testid={`remove-${userId}`}>
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove member?</AlertDialogTitle>
          <AlertDialogDescription>
            {email} will lose access to this project&apos;s runs and baselines.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => remove.mutate({ projectId, userId })}
            disabled={remove.isPending}
            data-testid={`remove-confirm-${userId}`}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
