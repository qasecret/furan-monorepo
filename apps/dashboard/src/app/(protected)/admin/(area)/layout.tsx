import type { ReactNode } from "react";

import { AdminTabs } from "./_components/admin-tabs";

import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getViewerRole } from "@/lib/get-viewer";

export const dynamic = "force-dynamic";

export default async function AdminAreaLayout({
  children,
}: {
  children: ReactNode;
}) {
  const role = await getViewerRole();
  if (role !== "admin") {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
          403 — admin only
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          You need the admin role to manage members.
        </p>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Admin" />
      <AdminTabs />
      <div>{children}</div>
    </div>
  );
}
