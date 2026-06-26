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
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { browserEnv } from "@/lib/env";

export type Role = "admin" | "editor" | "guest";

interface ChangeRoleCellProps {
  userId: string;
  value: Role;
  disabled?: boolean;
  onChanged?: (next: Role) => void;
}

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  editor: "Editor",
  guest: "Guest",
};

export function ChangeRoleCell({
  userId,
  value,
  disabled,
  onChanged,
}: ChangeRoleCellProps) {
  const [pending, setPending] = useState(false);
  const [current, setCurrent] = useState<Role>(value);
  // Non-null while a privileged (admin-involving) change awaits confirmation.
  const [confirmRole, setConfirmRole] = useState<Role | null>(null);

  const applyChange = async (next: Role): Promise<void> => {
    setPending(true);
    let res: Response;
    try {
      res = await fetch(`${browserEnv.NEXT_PUBLIC_API_URL}/users/${userId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
    } catch {
      setPending(false);
      toast.error("Failed to change role");
      return;
    }
    setPending(false);
    if (!res.ok) {
      const code = await readApiErrorCode(res);
      toast.error(USER_MUTATION_ERROR[code] ?? "Failed to change role");
      return;
    }
    setCurrent(next);
    toast.success("Role updated");
    onChanged?.(next);
  };

  const handleSelect = (next: Role): void => {
    if (next === current) return;
    // Granting or removing admin is privileged — confirm before applying.
    if (next === "admin" || current === "admin") {
      setConfirmRole(next);
      return;
    }
    void applyChange(next);
  };

  return (
    <>
      <Select
        value={current}
        onValueChange={(v) => handleSelect(v as Role)}
        disabled={disabled || pending || confirmRole !== null}
      >
        <SelectTrigger
          className="w-28"
          data-testid={`role-cell-${userId}`}
          aria-label={`Role for ${userId}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="editor">Editor</SelectItem>
          <SelectItem value="guest">Guest</SelectItem>
        </SelectContent>
      </Select>

      <AlertDialog
        open={confirmRole !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRole(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmRole === "admin"
                ? "Grant admin access?"
                : "Remove admin access?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRole === "admin"
                ? `This gives the user full admin privileges (${ROLE_LABEL[current]} → Admin).`
                : `This removes admin privileges (Admin → ${
                    confirmRole ? ROLE_LABEL[confirmRole] : ""
                  }).`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmRole(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const next = confirmRole;
                setConfirmRole(null);
                if (next) void applyChange(next);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
