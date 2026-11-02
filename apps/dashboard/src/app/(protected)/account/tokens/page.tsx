import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { TokensTable } from "./_components/tokens-table";
import { loadTokenPage } from "./_lib/load-token-page";

import { getViewerRole, isAtLeastAdmin } from "@/lib/get-viewer";

export const metadata: Metadata = { title: "Tokens" };
export const dynamic = "force-dynamic";

export default async function TokensPage() {
  const role = await getViewerRole();
  if (isAtLeastAdmin(role)) redirect("/admin/api-keys");

  const { tokens, projects, policy } = await loadTokenPage();

  return (
    <TokensTable initialTokens={tokens} projects={projects} policy={policy} />
  );
}
