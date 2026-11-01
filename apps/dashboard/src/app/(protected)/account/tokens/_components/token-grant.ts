import {
  DEFAULT_TOKEN_LIFETIME_DAYS,
  TOKEN_LIFETIME_DAYS,
  type TokenScope,
} from "@furan/shared-types";

/** A row of `GET /account/tokens`. */
export interface TokenRow {
  id: string;
  label: string;
  createdAt: string | Date;
  lastUsedAt: string | Date | null;
  lastUsedIp: string | null;
  scopes: TokenScope[];
  /** The one project the token works on; null = every project you're a member of. */
  projectId: string | null;
  projectName: string | null;
  expiresAt: string | Date | null;
}

/** `GET /account/token-policy`: what the operator allows a new token to be. */
export interface TokenPolicy {
  lifetimeDays: number[];
  defaultLifetimeDays: number;
  allowNoExpiry: boolean;
}

/** The policy when the api doesn't answer: the defaults the api ships with. */
export const FALLBACK_TOKEN_POLICY: TokenPolicy = {
  lifetimeDays: [...TOKEN_LIFETIME_DAYS],
  defaultLifetimeDays: DEFAULT_TOKEN_LIFETIME_DAYS,
  allowNoExpiry: false,
};

/** A project a token can be bound to. */
export interface ProjectOption {
  id: string;
  name: string;
}

export function isLegacy(row: Pick<TokenRow, "scopes">): boolean {
  return row.scopes.includes("legacy");
}

/** What the token may do, in a word or two. */
export function scopeLabel(scopes: TokenScope[]): string {
  if (scopes.includes("legacy")) return "Legacy";
  if (scopes.includes("sdk")) return "SDK & CI";
  return "Read-only";
}

export function projectLabel(
  row: Pick<TokenRow, "projectId" | "projectName">,
): string {
  if (row.projectId === null) return "All my projects";
  return row.projectName ?? "Unknown project";
}

function toDate(date: string | Date): Date {
  return typeof date === "string" ? new Date(date) : date;
}

export function formatDate(date: string | Date): string {
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Days within which an expiry is shown as a warning. */
const EXPIRING_SOON_DAYS = 7;

export type ExpiryState = "never" | "expired" | "soon" | "active";

/** Where the token stands against its expiry, and how to say it. */
export function expiry(
  expiresAt: string | Date | null,
  now: number = Date.now(),
): { state: ExpiryState; label: string } {
  if (expiresAt === null) return { state: "never", label: "Never expires" };
  const at = toDate(expiresAt).getTime();
  if (Number.isNaN(at)) return { state: "active", label: "—" };
  const ms = at - now;
  if (ms <= 0) return { state: "expired", label: "Expired" };
  const days = Math.ceil(ms / 86_400_000);
  if (days <= EXPIRING_SOON_DAYS) {
    return {
      state: "soon",
      label: days === 1 ? "Expires in 1 day" : `Expires in ${days} days`,
    };
  }
  return { state: "active", label: `Expires ${formatDate(expiresAt)}` };
}

/** "5m ago" / "Never" — when the token was last used. */
export function relative(date: string | Date | null): string {
  if (!date) return "Never";
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

/** A lifetime choice in the create dialog. */
export function lifetimeLabel(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? "1 year" : `${years} years`;
  }
  return days === 1 ? "1 day" : `${days} days`;
}
