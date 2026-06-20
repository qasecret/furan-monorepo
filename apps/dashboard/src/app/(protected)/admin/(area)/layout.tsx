import type { ReactNode } from "react";

import { AdminTabs } from "./_components/admin-tabs";

import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
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
      <PageContainer>
        <Card>
          <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
            403 — admin only
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            You need the admin role to access the admin area.
          </p>
        </Card>
      </PageContainer>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Admin" className="px-6 pt-6" />
      <AdminTabs />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
