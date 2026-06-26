"use client";

import { useState } from "react";
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
import { browserEnv } from "@/lib/env";

interface DeleteTokenButtonProps {
  tokenId: string;
  label: string;
  onDeleted?: () => void;
  children?: React.ReactNode;
}

export function DeleteTokenButton({
  tokenId,
  label,
  onDeleted,
  children,
}: DeleteTokenButtonProps) {
  const [pending, setPending] = useState(false);

  const onConfirm = async (): Promise<void> => {
    setPending(true);
    const res = await fetch(
      `${browserEnv.NEXT_PUBLIC_API_URL}/account/tokens/${tokenId}`,
      { method: "DELETE", credentials: "include" },
    );
    setPending(false);
    if (!res.ok) {
      toast.error("Failed to delete token");
      return;
    }
    toast.success("Token deleted");
    onDeleted?.();
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {children ?? (
          <Button variant="secondary" data-testid={`delete-token-${tokenId}`}>
            Delete
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete token &ldquo;{label}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Any client using this token will get 401s immediately. This cannot
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={pending}
            data-testid={`delete-token-confirm-${tokenId}`}
          >
            {pending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
