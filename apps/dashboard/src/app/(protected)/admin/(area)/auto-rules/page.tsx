import type { Metadata } from "next";

import { AutoRulesTable } from "./_components/auto-rules-table";

import { getViewerRole } from "@/lib/get-viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auto Rules" };

export default async function AutoRulesPage() {
  if ((await getViewerRole()) !== "admin") return null;
  return (
    <div id="auto-rules-table">
      <AutoRulesTable />
    </div>
  );
}
