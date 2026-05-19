import { Card } from "@/components/ui/card";

type Role = "admin" | "editor" | "guest";

interface Props {
  role: Role;
}

/**
 * Role-aware empty state for the projects list. Admins see API-create
 * guidance because the dashboard doesn't yet have a "Create project" page;
 * non-admins see prose explaining the access model.
 */
export function EmptyProjectsCta({ role }: Props) {
  if (role === "admin") {
    return (
      <Card>
        <div className="space-y-4 p-2">
          <div>
            <h2 className="text-lg font-medium">No projects yet</h2>
            <p className="text-sm text-neutral-600">
              The dashboard doesn&apos;t yet expose project creation. Use the
              API to create your first project — once it exists you&apos;ll see
              it here.
            </p>
          </div>
          <pre
            className="overflow-x-auto rounded bg-neutral-900 text-neutral-100 p-3 text-xs"
            data-testid="empty-projects-cta-curl"
          >
            {`# POST /api/v1/projects
curl -X POST https://furan.example.com/api/v1/projects \\
  -H "Authorization: Bearer furan_pat_…" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"my-app","mainBranchName":"main"}'`}
          </pre>
          <p className="text-xs text-neutral-500">
            Need a token?{" "}
            <a
              href="/settings/tokens"
              className="text-blue-700 hover:underline"
            >
              Create a personal access token →
            </a>
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="space-y-2 p-2">
        <h2 className="text-lg font-medium">
          You&apos;re not a member of any project yet
        </h2>
        <p className="text-sm text-neutral-600">
          Ask your administrator to add you to an existing project, or to create
          a new one and grant you access.
        </p>
      </div>
    </Card>
  );
}
