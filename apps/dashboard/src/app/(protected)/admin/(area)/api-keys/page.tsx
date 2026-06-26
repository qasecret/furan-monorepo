import type { Metadata } from "next";

import { ApiKeysPanel } from "./_components/api-keys-panel";

import type { TokenRow } from "@/app/(protected)/account/tokens/_components/tokens-table";
import { apiGet } from "@/lib/api-client";

export const metadata: Metadata = { title: "API Keys" };
export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const { data } = await apiGet<TokenRow[]>("/account/tokens");
  const tokens = Array.isArray(data) ? data : [];

  return <ApiKeysPanel initialTokens={tokens} />;
}
