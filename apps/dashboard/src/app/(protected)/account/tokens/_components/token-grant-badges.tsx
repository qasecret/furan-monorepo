import { TriangleAlert } from "lucide-react";

import {
  expiry,
  formatDate,
  isLegacy,
  projectLabel,
  scopeLabel,
  type TokenRow,
} from "./token-grant";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { statusStyle } from "@/lib/status-style";

/** The token's scope as a badge; a legacy token reads as a warning. */
export function ScopeBadge({ token }: { token: Pick<TokenRow, "scopes"> }) {
  return (
    <Badge
      className={cn(isLegacy(token) && statusStyle("unresolved").pill)}
      data-testid="token-scope"
    >
      {scopeLabel(token.scopes)}
    </Badge>
  );
}

/** "Expires Jan 30, 2027" / "Expires in 3 days" / "Expired" / "Never expires". */
export function ExpiryText({ token }: { token: Pick<TokenRow, "expiresAt"> }) {
  const { state, label } = expiry(token.expiresAt);
  return (
    <span
      className={cn(
        "tabular-nums",
        state === "expired" && statusStyle("failed").text,
        state === "soon" && statusStyle("unresolved").text,
        (state === "active" || state === "never") && "text-fg-muted",
      )}
      data-testid="token-expiry"
    >
      {label}
    </span>
  );
}

export function ProjectText({
  token,
}: {
  token: Pick<TokenRow, "projectId" | "projectName">;
}) {
  return (
    <span
      className={token.projectId === null ? "text-fg-muted" : "text-fg"}
      data-testid="token-project"
    >
      {projectLabel(token)}
    </span>
  );
}

/**
 * Shown while any token predates scopes (ADR-064 step B): a legacy token works
 * on every project its owner can reach and can accept any change, until it
 * expires 90 days after the upgrade.
 */
export function LegacyTokensNotice({ tokens }: { tokens: TokenRow[] }) {
  const legacy = tokens.filter(isLegacy);
  if (legacy.length === 0) return null;
  const firstExpiry = legacy
    .map((t) => t.expiresAt)
    .filter((d): d is string | Date => d !== null)
    .map((d) => new Date(d))
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const count =
    legacy.length === 1 ? "1 token was" : `${legacy.length} tokens were`;
  return (
    <div
      className={cn(
        "mb-5 flex items-start gap-3 rounded-lg px-4 py-3",
        statusStyle("unresolved").pill,
      )}
      data-testid="legacy-tokens-notice"
      role="status"
    >
      <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="text-xs leading-relaxed text-fg">
        {count} created before token scopes. Legacy tokens work on every project
        you can reach and can approve any change
        {firstExpiry ? (
          <>
            , and they stop working on{" "}
            <span className="font-medium">{formatDate(firstExpiry)}</span>
          </>
        ) : null}
        . Create a scoped token, update your CI secret, then delete the legacy
        one.
      </p>
    </div>
  );
}
