import type { ReactNode } from "react";

import { AdminTabs } from "./_components/admin-tabs";

import { Forbidden } from "@/components/ui/forbidden";
import { PageContainer } from "@/components/ui/page-container";
import { getViewerRole, isAtLeastAdmin } from "@/lib/get-viewer";

export const dynamic = "force-dynamic";

export default async function AdminAreaLayout({
  children,
}: {
  children: ReactNode;
}) {
  const role = await getViewerRole();
  if (!isAtLeastAdmin(role)) {
    return (
      <PageContainer>
        <Forbidden
          title="403 — admin only"
          description="You need the admin role to access the admin area."
        />
      </PageContainer>
    );
  }
  return (
    <PageContainer maxWidth="5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-950 dark:text-white">
          Admin
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Manage users, projects, and integrations.
        </p>
      </div>
      <div className="flex gap-8">
        <AdminTabs />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </PageContainer>
  );
}
