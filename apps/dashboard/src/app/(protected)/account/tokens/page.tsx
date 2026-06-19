import type { Metadata } from "next";

import { TokensTable, type TokenRow } from "./_components/tokens-table";

import { SetBreadcrumbs } from "@/app/(protected)/_components/set-breadcrumbs";
import { PageTour } from "@/components/tour/page-tour";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { apiGet } from "@/lib/api-client";

export const metadata: Metadata = { title: "Tokens" };
export const dynamic = "force-dynamic";

const TOKENS_PAGE_TOUR = [
  {
    target: "#tokens-table",
    title: "Personal access tokens",
    content:
      "Mint a token here, then paste it into your CI as the FURAN_API_TOKEN env var. Each token shows once on creation — copy it immediately.",
    placement: "top" as const,
  },
];

export default async function TokensPage() {
  const { data } = await apiGet<TokenRow[]>("/account/tokens");
  const tokens = Array.isArray(data) ? data : [];

  return (
    <PageContainer>
      <div className="space-y-4">
        <SetBreadcrumbs items={[{ label: "Tokens" }]} />
        <PageTour pageId="account-tokens" steps={TOKENS_PAGE_TOUR} />
        <PageHeader
          title="Personal access tokens"
          description="Use these tokens to authenticate the Furan SDK or CI uploads. Each token grants the same access as your account."
        />
        <div id="tokens-table">
          <TokensTable initialTokens={tokens} />
        </div>
      </div>
    </PageContainer>
  );
}
