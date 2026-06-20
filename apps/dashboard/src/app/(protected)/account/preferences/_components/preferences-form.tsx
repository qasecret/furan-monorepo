"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";

interface ProjectItem {
  id: string;
  name: string;
}

export function PreferencesForm({
  projects,
  currentDefaultId,
}: {
  projects: ProjectItem[];
  currentDefaultId: string | null;
}) {
  const [selected, setSelected] = useState<string>(currentDefaultId ?? "");
  const [savedDefault, setSavedDefault] = useState<string>(
    currentDefaultId ?? "",
  );
  const setDefault = trpc.account.setDefaultProject.useMutation({
    onSuccess: () => {
      setSavedDefault(selected);
      toast.success("Default project saved");
    },
    onError: (e: { message: string }) => {
      toast.error(e.message || "Couldn't save default project");
    },
  });

  if (projects.length === 0) {
    return (
      <p
        className="text-sm text-zinc-500"
        data-testid="preferences-no-projects"
      >
        No projects yet. Create a project first to set a default.
      </p>
    );
  }

  const dirty = selected !== savedDefault;

  return (
    <div className="max-w-md space-y-3" data-testid="preferences-form">
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          Default project
        </p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The project you land on when you sign in. Switching projects from the
          header is temporary and won&apos;t change this.
        </p>
      </div>
      <Select value={selected} onValueChange={setSelected}>
        <SelectTrigger className="w-full" data-testid="preferences-select">
          <SelectValue placeholder="Select a project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        data-testid="preferences-save"
        disabled={!dirty || setDefault.isPending}
        onClick={() => setDefault.mutate({ projectId: selected })}
      >
        {setDefault.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
