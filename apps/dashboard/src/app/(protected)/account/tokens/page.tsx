import type { Metadata } from "next";

import { TokensTable, type TokenRow } from "./_components/tokens-table";

import { PageTour } from "@/components/tour/page-tour";
import { apiGet } from "@/lib/api-client";

export const metadata: Metadata = { title: "Tokens" };
export const dynamic = "force-dynamic";

const TOKENS_PAGE_TOUR = [
  {
    target: "#tokens-table",
    title: "Personal access tokens",
    content:
      "Mint a token here, then paste it into your CI as the FURAN_API_KEY env var. Each token shows once on creation — copy it immediately.",
    placement: "top" as const,
  },
];

export default async function TokensPage() {
  const { data } = await apiGet<TokenRow[]>("/account/tokens");
  const tokens = Array.isArray(data) ? data : [];

  return (
    <div className="space-y-4">
      <PageTour pageId="account-tokens" steps={TOKENS_PAGE_TOUR} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Personal access tokens
        </h1>
        <p className="text-sm text-zinc-400">
          Use these tokens to authenticate the Furan SDK or CI uploads. Each
          token grants the same access as your account.
        </p>
      </div>
      <div id="tokens-table">
        <TokensTable initialTokens={tokens} />
      </div>
    </div>
  );
}
