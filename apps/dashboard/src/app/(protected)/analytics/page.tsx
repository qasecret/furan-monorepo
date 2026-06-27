import type { Metadata } from "next";

import { AnalyticsPage } from "./_components/analytics-page";

import { Forbidden } from "@/components/ui/forbidden";
import { PageContainer } from "@/components/ui/page-container";
import { getViewerRole, isAtLeastAdmin } from "@/lib/get-viewer";

export const metadata: Metadata = { title: "Analytics" };

export const dynamic = "force-dynamic";

export default async function Page() {
  const role = await getViewerRole();
  if (!isAtLeastAdmin(role)) {
    return (
      <PageContainer>
        <Forbidden
          title="403 — admin only"
          description="You need the admin role to view analytics."
        />
      </PageContainer>
    );
  }
  return <AnalyticsPage />;
}
