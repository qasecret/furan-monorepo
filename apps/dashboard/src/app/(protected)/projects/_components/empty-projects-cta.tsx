import { CreateProjectDialog } from "./create-project-dialog";

import { Card } from "@/components/ui/card";

type Role = "admin" | "editor" | "guest";

interface Props {
  role: Role;
}

/**
 * Role-aware empty state for the projects list. Admins see a Create-project
 * dialog trigger; non-admins see prose explaining the access model.
 */
export function EmptyProjectsCta({ role }: Props) {
  if (role === "admin") {
    return (
      <Card>
        <div className="space-y-4 p-2">
          <div>
            <h2 className="text-lg font-semibold text-white">
              No projects yet
            </h2>
            <p className="text-sm text-zinc-400">
              Create your first project to get started. You&apos;ll mint a
              personal access token and connect the SDK next.
            </p>
          </div>
          <CreateProjectDialog />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="space-y-2 p-2">
        <h2 className="text-lg font-semibold text-white">
          You&apos;re not a member of any project yet
        </h2>
        <p className="text-sm text-zinc-400">
          Ask your administrator to add you to an existing project, or to create
          a new one and grant you access.
        </p>
      </div>
    </Card>
  );
}
