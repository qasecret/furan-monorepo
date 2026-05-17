"use client";

import { useState } from "react";
import { toast } from "sonner";

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

export function ChangeRoleCell({
  userId,
  value,
  disabled,
  onChanged,
}: ChangeRoleCellProps) {
  const [pending, setPending] = useState(false);
  const [current, setCurrent] = useState<Role>(value);

  const handleChange = async (next: Role): Promise<void> => {
    if (next === current) return;
    setPending(true);
    const res = await fetch(
      `${browserEnv.NEXT_PUBLIC_API_URL}/users/${userId}`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: next }),
      },
    );
    setPending(false);
    if (!res.ok) {
      toast.error("Failed to change role");
      return;
    }
    setCurrent(next);
    toast.success("Role updated");
    onChanged?.(next);
  };

  return (
    <Select
      value={current}
      onValueChange={(v) => void handleChange(v as Role)}
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
  );
}
