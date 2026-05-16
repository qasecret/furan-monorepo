import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const dynamic = "force-dynamic";

interface Project {
  id: string;
  name: string;
  mainBranchName: string;
}

export default async function ProjectsPage() {
  const { data, status } = await apiGet<Project[]>("/projects");
  if (status === 401 || status === 403) {
    return <p>Not authorized.</p>;
  }
  const projects = data ?? [];
  if (projects.length === 0) {
    return (
      <Card>
        <p>No projects yet. Ask an admin to create one.</p>
      </Card>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <Card key={p.id}>
          <h2 className="text-lg font-semibold">{p.name}</h2>
          <p className="text-sm text-neutral-600">
            Main branch: {p.mainBranchName}
          </p>
        </Card>
      ))}
    </div>
  );
}
