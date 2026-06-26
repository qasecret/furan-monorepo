import type { Metadata } from "next";

import { AuditLogTable } from "./_components/audit-log-table";

import { getViewerRole, isAtLeastAdmin } from "@/lib/get-viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit Log" };

export default async function AuditLogPage() {
  if (!isAtLeastAdmin(await getViewerRole())) return null;
  return (
    <div id="audit-log-table">
      <AuditLogTable />
    </div>
  );
}
