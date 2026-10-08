import { isIP } from "node:net";

/** The subset of Fastify's `trustProxy` option that TRUST_PROXY can express. */
export type TrustProxySetting = boolean | string[];

/** proxy-addr's named ranges (Fastify compiles list entries with proxy-addr). */
const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * Parse the TRUST_PROXY env var into Fastify's `trustProxy` option, which
 * decides whether `X-Forwarded-For` feeds `req.ip` (and so every per-IP rate
 * limit, ADR-063). Grammar:
 *
 * - unset / `""` / `false` → `false` (default): XFF is ignored and `req.ip`
 *   is the socket peer. Safe whatever the network topology.
 * - `true` → trust every hop: the left-most XFF entry wins. Spoofable unless
 *   the API is reachable ONLY through the proxy (server.ts warns at boot).
 * - a comma-separated list of proxy addresses: IPs, CIDRs (`10.0.0.0/8`),
 *   or `loopback` / `linklocal` / `uniquelocal`. X-Forwarded-For is honoured
 *   only when the immediate peer is one of them.
 * - a bare hop count (`1`) is REJECTED (ADR-065): Fastify >= 5.12 ignores
 *   numeric trustProxy — it fails closed because a hop count can't tell the
 *   real proxy from a direct client sending extra X-Forwarded-For entries —
 *   so accepting it would silently disable per-IP rate limiting.
 *
 * Anything else throws, so a typo fails boot instead of silently trusting (or
 * ignoring) the proxy. Messages never echo the raw value (getEnv convention).
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? "").trim();
  const lower = value.toLowerCase();
  if (lower === "" || lower === "false") return false;
  if (lower === "true") return true;
  if (/^\d+$/.test(value)) {
    throw new Error(
      "TRUST_PROXY hop counts are not supported (Fastify ignores them) — list the proxy's IP / CIDR, or loopback|linklocal|uniquelocal",
    );
  }
  return value.split(",").map((part, i) => {
    const entry = part.trim();
    const keyword = entry.toLowerCase();
    if (KEYWORDS.has(keyword)) return keyword;
    if (isAddressOrCidr(entry)) return entry;
    throw new Error(
      `TRUST_PROXY entry ${i + 1} is not an IP address, a CIDR range, or one of loopback|linklocal|uniquelocal`,
    );
  });
}

function isAddressOrCidr(entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash === -1) return isIP(entry) !== 0;
  const family = isIP(entry.slice(0, slash));
  const prefix = entry.slice(slash + 1);
  if (family === 0 || !/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}
