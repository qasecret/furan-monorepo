import type { Metadata } from "next";

import { InstallationsTable } from "./_components/installations-table";

export const metadata: Metadata = { title: "Installations" };

export const dynamic = "force-dynamic";

export default async function InstallationsAdminPage() {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <h3 className="text-base font-medium text-zinc-950 dark:text-white">
          Installations
        </h3>
        <p className="mt-1 text-xs text-zinc-500">
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
