import type { Metadata } from "next";

import { PreferencesForm } from "./_components/preferences-form";

import { SetBreadcrumbs } from "@/app/(protected)/_components/set-breadcrumbs";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { apiGet } from "@/lib/api-client";

export const metadata: Metadata = { title: "Preferences" };
export const dynamic = "force-dynamic";

interface Me {
  defaultProjectId: string | null;
}

interface ProjectApiItem {
  id: string;
  name: string;
}

export default async function PreferencesPage() {
  const [meRes, projectsRes] = await Promise.all([
    apiGet<Me>("/users/me"),
    apiGet<ProjectApiItem[]>("/projects"),
  ]);
  const projects = (projectsRes.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  const currentDefaultId = meRes.data?.defaultProjectId ?? null;

  return (
    <PageContainer>
      <div className="space-y-4">
        <SetBreadcrumbs items={[{ label: "Preferences" }]} />
        <PageHeader
          title="Preferences"
          description="Your personal dashboard preferences."
        />
        <PreferencesForm
          projects={projects}
          currentDefaultId={currentDefaultId}
        />
      </div>
    </PageContainer>
  );
}
