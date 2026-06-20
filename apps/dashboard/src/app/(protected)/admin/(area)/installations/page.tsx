import type { Metadata } from "next";

import { InstallationsTable } from "./_components/installations-table";

import { SetBreadcrumbs } from "@/app/(protected)/_components/set-breadcrumbs";
import { PageContainer } from "@/components/ui/page-container";

export const metadata: Metadata = { title: "Installations" };

export const dynamic = "force-dynamic";

/**
 * Admin-only page that maps GitHub App installations to Furan projects
 * (D6(f)). Replaces the manual `UPDATE installations SET project_id = ...`
 * step previously documented in `docs/integrations/github-actions.md` §2.
 * Admin access is enforced by the (area)/layout.tsx gate.
 */
export default async function InstallationsAdminPage() {
  return (
    <PageContainer>
      <div className="space-y-4">
        <SetBreadcrumbs
          items={[
            { label: "Admin", href: "/admin" },
            { label: "Installations" },
          ]}
        />
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Link each GitHub App installation to a Furan project so its webhook
          events (PR runs, status checks) route to the right place. Changes save
          immediately.
        </p>
        <InstallationsTable />
      </div>
    </PageContainer>
  );
}
