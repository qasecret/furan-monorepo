"use client";

import { CopyField } from "@/components/ui/copy-field";

/** The project's ID, which the SDK needs as FURAN_PROJECT_ID, to copy. */
export function ProjectIdRow({ projectId }: { projectId: string }) {
  return (
    <div className="mt-3 max-w-md space-y-1">
      <p className="text-xs font-medium text-fg-secondary">Project ID</p>
      <CopyField
        value={projectId}
        label="project ID"
        data-testid="project-id"
      />
    </div>
  );
}
