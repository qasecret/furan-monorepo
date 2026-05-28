import type { Metadata } from "next";

import { AnalyticsPage } from "./_components/analytics-page";

export const metadata: Metadata = { title: "Analytics" };

export default function Page() {
  return <AnalyticsPage />;
}
