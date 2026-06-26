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

// Server error code → human message. Mirrors the guards in
// apps/api/src/routes/users-admin-guards.ts.
const ERROR_MESSAGE: Record<string, string> = {
  cannot_change_own_role: "You can't change your own role — ask another admin.",
  last_admin: "At least one active admin must remain.",
  cannot_disable_self: "You can't deactivate your own account.",
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
      let code = "";
      try {
        code = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        // non-JSON body — fall through to the generic message
      }
      toast.error(ERROR_MESSAGE[code] ?? "Failed to change role");
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
        disabled={disabled || pending}
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
