import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { TokensTable, type TokenRow } from "./_components/tokens-table";

import { apiGet } from "@/lib/api-client";
import { getViewerRole, isAtLeastAdmin } from "@/lib/get-viewer";

export const metadata: Metadata = { title: "Tokens" };
export const dynamic = "force-dynamic";

export default async function TokensPage() {
  const role = await getViewerRole();
  if (isAtLeastAdmin(role)) redirect("/admin/api-keys");

  const { data } = await apiGet<TokenRow[]>("/account/tokens");
  const tokens = Array.isArray(data) ? data : [];

  return <TokensTable initialTokens={tokens} />;
}
