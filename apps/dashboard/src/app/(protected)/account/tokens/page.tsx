import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const dynamic = "force-dynamic";

interface Token {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export default async function TokensPage() {
  const { data } = await apiGet<Token[]>("/account/tokens");
  const tokens = data ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Personal API Tokens</h1>
      <p className="text-sm text-neutral-600">
        Token creation lands with the simplified-auth UI wave (Phase 3).
      </p>
      <div className="space-y-2">
        {tokens.map((t) => (
          <Card key={t.id}>
            <p className="font-medium">{t.label}</p>
            <p className="text-xs text-neutral-500">
              Created {new Date(t.createdAt).toLocaleString()}
              {t.lastUsedAt &&
                ` · Last used ${new Date(t.lastUsedAt).toLocaleString()}`}
            </p>
          </Card>
        ))}
        {tokens.length === 0 && <Card>No tokens yet.</Card>}
      </div>
    </div>
  );
}
