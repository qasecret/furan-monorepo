"use client";

import { useState } from "react";
import { toast } from "sonner";

import { readApiErrorCode, USER_MUTATION_ERROR } from "./user-mutation-errors";

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

interface DeactivateButtonProps {
  userId: string;
  isActive: boolean;
  isSelf: boolean;
  onChanged?: (nextActive: boolean) => void;
}

export function DeactivateButton({
  userId,
  isActive,
  isSelf,
  onChanged,
}: DeactivateButtonProps) {
  const [pending, setPending] = useState(false);
  const targetActive = !isActive;
  const label = isActive ? "Deactivate" : "Reactivate";

  const onConfirm = async (): Promise<void> => {
    setPending(true);
    const res = await fetch(
      `${browserEnv.NEXT_PUBLIC_API_URL}/users/${userId}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: targetActive }),
      },
    );
    setPending(false);
    if (!res.ok) {
      const code = await readApiErrorCode(res);
      toast.error(
        USER_MUTATION_ERROR[code] ?? `Failed to ${label.toLowerCase()}`,
      );
      return;
    }
    toast.success(`User ${targetActive ? "reactivated" : "deactivated"}`);
    onChanged?.(targetActive);
  };

  // Self-row: deactivate is forbidden by API (cannot_disable_self). Render a
  // disabled button with an explanatory title so the user understands why.
  if (isSelf && isActive) {
    return (
      <Button
        variant="secondary"
        disabled
        title="You can't deactivate your own account"
        data-testid={`deactivate-${userId}`}
        aria-label="You can't deactivate your own account"
      >
        Deactivate
      </Button>
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="secondary" data-testid={`deactivate-${userId}`}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label} this user?</AlertDialogTitle>
          <AlertDialogDescription>
            {targetActive
              ? "The user will be able to sign in again."
              : "The user will be signed out and unable to sign in until reactivated."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={targetActive ? "default" : "destructive"}
            onClick={() => void onConfirm()}
            disabled={pending}
            data-testid={`deactivate-confirm-${userId}`}
          >
            {pending ? "Working…" : label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
