import { InstallationsTable } from "./_components/installations-table";

import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const dynamic = "force-dynamic";

interface Me {
  id: string;
  role: "admin" | "editor" | "guest";
}

/**
 * Admin-only page that maps GitHub App installations to Furan projects
 * (D6(f)). Replaces the manual `UPDATE installations SET project_id = ...`
 * step previously documented in `docs/integrations/github-actions.md` §2.
 */
export default async function InstallationsAdminPage() {
  const me = await apiGet<Me>("/users/me");
  if (
    me.status === 401 ||
    me.status === 403 ||
    !me.data ||
    me.data.role !== "admin"
  ) {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-white">403 — admin only</h1>
        <p className="text-sm text-zinc-400">
          You need the admin role to manage GitHub App installations.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-white">
        GitHub App installations
      </h1>
      <p className="text-sm text-zinc-400">
        Link each GitHub App installation to a Furan project so its webhook
        events (PR runs, status checks) route to the right place. Changes save
        immediately.
      </p>
      <InstallationsTable />
    </div>
  );
}
