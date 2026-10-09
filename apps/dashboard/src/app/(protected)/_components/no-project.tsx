import { Card } from "@/components/ui/card";

/**
 * Terminal landing state (U8) for a signed-in user who has no project to land
 * on — an editor with no membership and no usable default project. Single-
 * project tenancy has no project switcher, so there is nothing for them to do
 * here but wait for an admin to assign them a project. Rendered by the `/home`
 * resolver (and `/projects`) when `resolveLanding` returns null.
 */
export function NoProject() {
  return (
    <div
      data-testid="no-project"
      className="flex min-h-[60vh] items-center justify-center p-6"
    >
      <Card className="max-w-md text-center">
        <div className="space-y-2 p-2">
          <h1 className="text-lg font-semibold text-fg">No project assigned</h1>
          <p className="text-sm text-fg-secondary">
            Ask an admin to add you to a project.
          </p>
        </div>
      </Card>
    </div>
  );
}
