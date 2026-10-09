"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";

interface ProjectItem {
  id: string;
  name: string;
}

interface AssignProjectsDialogProps {
  userId: string;
  userEmail: string;
  defaultProjectId: string | null;
  allProjects: ProjectItem[];
}

// Sentinel for the "None" option — Radix Select disallows an empty-string value.
const NONE = "__none__";

export function AssignProjectsDialog({
  userId,
  userEmail,
  defaultProjectId,
  allProjects,
}: AssignProjectsDialogProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const utils = trpc.useUtils();

  // Local edit state, seeded from the server when the dialog opens.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedDefault, setSelectedDefault] = useState<string | null>(
    defaultProjectId,
  );

  const membership = trpc.members.listUserProjects.useQuery(
    { userId },
    { enabled: open },
  );

  // Seed local state from the membership query (and the default prop) once the
  // dialog is open and the ids have loaded. Re-seeding on every `data` identity
  // change is fine — react-query keeps the reference stable between refetches.
  useEffect(() => {
    if (!open) return;
    if (membership.data) {
      setChecked(new Set(membership.data));
    }
    setSelectedDefault(defaultProjectId);
  }, [open, membership.data, defaultProjectId]);

  const setProjects = trpc.members.setUserProjects.useMutation({
    onSuccess: () => {
      toast.success("Projects updated");
      setOpen(false);
      void utils.members.listUserProjects.invalidate({ userId });
      router.refresh();
    },
    onError: (e: { message: string }) => {
      toast.error(e.message || "Failed to update projects");
    },
  });

  const toggle = (projectId: string, next: boolean): void => {
    setChecked((prev) => {
      const updated = new Set(prev);
      if (next) {
        updated.add(projectId);
      } else {
        updated.delete(projectId);
      }
      return updated;
    });
    // If the project that was the default just got unchecked, drop the default.
    if (!next && selectedDefault === projectId) {
      setSelectedDefault(null);
    }
  };

  const onSave = (): void => {
    setProjects.mutate({
      userId,
      projectIds: [...checked],
      // Guard: the default must be one of the checked projects (or null).
      defaultProjectId:
        selectedDefault && checked.has(selectedDefault)
          ? selectedDefault
          : null,
    });
  };

  const checkedProjects = allProjects.filter((p) => checked.has(p.id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" data-testid="assign-projects-trigger">
          Projects
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign projects</DialogTitle>
          <DialogDescription>
            Choose which projects {userEmail} belongs to, and which one they
            land on when they sign in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Memberships</Label>
            {membership.isLoading ? (
              <p className="text-sm text-fg-muted" data-testid="assign-loading">
                Loading…
              </p>
            ) : membership.isError ? (
              <p
                className="text-sm text-destructive"
                data-testid="assign-error"
              >
                Couldn&apos;t load this user&apos;s projects.
              </p>
            ) : allProjects.length === 0 ? (
              <p
                className="text-sm text-fg-muted"
                data-testid="assign-no-projects"
              >
                No projects yet.
              </p>
            ) : (
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {allProjects.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-edge px-3 py-2"
                  >
                    <Label
                      htmlFor={`assign-project-${p.id}`}
                      className="cursor-pointer"
                    >
                      {p.name}
                    </Label>
                    <Switch
                      id={`assign-project-${p.id}`}
                      data-testid={`assign-project-${p.id}`}
                      checked={checked.has(p.id)}
                      onCheckedChange={(next) => toggle(p.id, next)}
                      aria-label={`Toggle membership in ${p.name}`}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="assign-default-select">Default project</Label>
            <Select
              value={selectedDefault ?? NONE}
              onValueChange={(v) => setSelectedDefault(v === NONE ? null : v)}
            >
              <SelectTrigger
                id="assign-default-select"
                className="w-full"
                data-testid="assign-default-select"
              >
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {checkedProjects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-fg-muted">
              Only projects the user belongs to can be their default.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={onSave}
            disabled={
              setProjects.isPending ||
              membership.isLoading ||
              membership.isError
            }
            data-testid="assign-projects-save"
          >
            {setProjects.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
