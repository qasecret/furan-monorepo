import { TokensTable, type TokenRow } from "./_components/tokens-table";

import { apiGet } from "@/lib/api-client";

export const dynamic = "force-dynamic";

export default async function TokensPage() {
  const { data } = await apiGet<TokenRow[]>("/account/tokens");
  const tokens = Array.isArray(data) ? data : [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Personal access tokens
        </h1>
        <p className="text-sm text-zinc-400">
          Use these tokens to authenticate the Furan SDK or CI uploads. Each
          token grants the same access as your account.
        </p>
      </div>
      <TokensTable initialTokens={tokens} />
    </div>
  );
}
