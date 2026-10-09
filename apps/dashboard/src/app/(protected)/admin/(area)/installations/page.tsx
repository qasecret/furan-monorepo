import type { Metadata } from "next";

import { InstallationsTable } from "./_components/installations-table";

export const metadata: Metadata = { title: "Installations" };

export const dynamic = "force-dynamic";

export default async function InstallationsAdminPage() {
  return (
    <div className="rounded-lg bg-raised shadow-raised">
      <div className="border-b border-edge px-6 py-4">
        <h3 className="text-base font-medium text-fg">Installations</h3>
        <p className="mt-1 text-xs text-fg-muted">
          Link each GitHub App installation to a Furan project so its webhook
          events route to the right place. Changes save immediately.
        </p>
      </div>
      <div className="p-6">
        <InstallationsTable />
      </div>
    </div>
  );
}
