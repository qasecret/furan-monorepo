import type { Metadata } from "next";

import { AnalyticsPage } from "./_components/analytics-page";

import { SetBreadcrumbs } from "@/app/(protected)/_components/set-breadcrumbs";

export const metadata: Metadata = { title: "Analytics" };

export default function Page() {
  return (
    <>
      <SetBreadcrumbs items={[{ label: "Analytics" }]} />
      <AnalyticsPage />
    </>
  );
}
