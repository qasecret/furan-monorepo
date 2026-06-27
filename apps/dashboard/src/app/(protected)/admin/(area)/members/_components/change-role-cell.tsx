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
import { isAtLeastAdmin, roleRank, type ViewerRole } from "@/lib/roles";

export type Role = ViewerRole;

interface ChangeRoleCellProps {
  userId: string;
  value: Role;
  disabled?: boolean;
  /**
   * The row is an owner and the viewer is not — only an owner may change/demote
   * an owner (separation of duties), so the cell is read-only. Computed once by
   * the table (see `ownerRowLockedForViewer`) and shared with the deactivate
   * control. The API enforces this regardless (403 `owner_protected`); this is
   * defense-in-depth + clearer UX.
   */
  lockedForViewer?: boolean;
  onChanged?: (next: Role) => void;
}

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  guest: "Guest",
};

/** Granting or removing an admin/owner tier is privileged → confirm first. */
const isPrivileged = (role: Role): boolean => isAtLeastAdmin(role);

export function ChangeRoleCell({
  userId,
  value,
  disabled,
  lockedForViewer = false,
  onChanged,
}: ChangeRoleCellProps) {
  const [pending, setPending] = useState(false);
  const [current, setCurrent] = useState<Role>(value);
  // Non-null while a privileged (admin/owner-involving) change awaits confirm.
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
    // Granting or removing an admin/owner tier is privileged — confirm first.
    if (isPrivileged(next) || isPrivileged(current)) {
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
        disabled={
          disabled || lockedForViewer || pending || confirmRole !== null
        }
      >
        <SelectTrigger
          className="w-28"
          data-testid={`role-cell-${userId}`}
          aria-label={`Role for ${userId}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="owner">Owner</SelectItem>
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
              {confirmRole && roleRank(confirmRole) > roleRank(current)
                ? `Grant ${ROLE_LABEL[confirmRole]} access?`
                : `Change role to ${confirmRole ? ROLE_LABEL[confirmRole] : ""}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRole && roleRank(confirmRole) > roleRank(current)
                ? `This gives the user full ${ROLE_LABEL[
                    confirmRole
                  ].toLowerCase()} privileges (${ROLE_LABEL[current]} → ${
                    ROLE_LABEL[confirmRole]
                  }).`
                : `This changes the user from ${ROLE_LABEL[current]} to ${
                    confirmRole ? ROLE_LABEL[confirmRole] : ""
                  }.`}
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
