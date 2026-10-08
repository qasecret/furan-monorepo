import { isIP } from "node:net";

/** The subset of Fastify's `trustProxy` option that TRUST_PROXY can express. */
export type TrustProxySetting = boolean | number | string[];

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
 * - a non-negative integer N → trust the N closest hops (`1` = one reverse
 *   proxy in front, e.g. the bundled nginx).
 * - otherwise a comma-separated list of proxy addresses: IPs, CIDRs
 *   (`10.0.0.0/8`), or `loopback` / `linklocal` / `uniquelocal`.
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
    const hops = Number(value);
    if (!Number.isSafeInteger(hops)) {
      throw new Error("TRUST_PROXY hop count is out of range");
    }
    return hops;
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
