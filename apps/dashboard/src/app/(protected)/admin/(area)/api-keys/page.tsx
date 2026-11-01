import type { Metadata } from "next";

import { ApiKeysPanel } from "./_components/api-keys-panel";

import { loadTokenPage } from "@/app/(protected)/account/tokens/_lib/load-token-page";

export const metadata: Metadata = { title: "API Keys" };
export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const { tokens, projects, policy } = await loadTokenPage();

  return (
    <ApiKeysPanel initialTokens={tokens} projects={projects} policy={policy} />
  );
}
