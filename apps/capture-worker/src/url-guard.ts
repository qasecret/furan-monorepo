import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for capture targets.
 *
 * Furan is a self-hostable VRT tool, so capturing internal/staging apps on
 * private networks is a legitimate, common use case — a blanket private-range
 * block would break the product. This guard therefore splits into two tiers:
 *
 *   - ALWAYS blocked (no legitimate capture target lives here): non-http(s)
 *     schemes (file:, data:, gopher:, …) and the cloud-metadata / link-local
 *     range 169.254.0.0/16 + IPv6 fe80::/10 (AWS/GCP/Azure IMDS lives at
 *     169.254.169.254 — a classic SSRF credential-exfil vector).
 *   - OPT-IN blocked (`blockPrivate`, default off): loopback, RFC-1918,
 *     CGNAT (100.64/10), IPv6 ULA (fc00::/7), and the unspecified address —
 *     for operators who never legitimately screenshot internal hosts.
 *
 * Hostnames are resolved (DNS) and every resolved address is checked, so a
 * name pointing at a blocked range is caught too. This is not full DNS-
 * rebinding protection (that requires pinning the connection to the vetted
 * IP, out of scope here) but it closes the direct and simple-indirect vectors.
 */
export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`capture URL blocked: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function ipv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

/** Always-blocked v4 ranges (metadata / link-local). */
function isAlwaysBlockedV4(o: [number, number, number, number]): boolean {
  return o[0] === 169 && o[1] === 254; // 169.254.0.0/16 (incl. IMDS)
}

/** Opt-in-blocked v4 ranges (loopback + private + CGNAT + unspecified). */
function isPrivateV4(o: [number, number, number, number]): boolean {
  if (o[0] === 127) return true; // 127.0.0.0/8 loopback
  if (o[0] === 10) return true; // 10.0.0.0/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
  if (o[0] === 192 && o[1] === 168) return true; // 192.168.0.0/16
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // 100.64.0.0/10 CGNAT
  if (o[0] === 0) return true; // 0.0.0.0/8 unspecified/this-host
  return false;
}

function classifyIp(
  ip: string,
  blockPrivate: boolean,
): "ok" | "always" | "private" {
  // Normalize IPv4-mapped IPv6 (::ffff:169.254.169.254) to its v4 form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped?.[1] ?? (isIP(ip) === 4 ? ip : null);
  if (v4) {
    const o = ipv4Octets(v4);
    if (!o) return "ok";
    if (isAlwaysBlockedV4(o)) return "always";
    if (blockPrivate && isPrivateV4(o)) return "private";
    return "ok";
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower.startsWith("fe8") || lower.startsWith("fe9")) return "always"; // fe80::/10 link-local
  if (lower.startsWith("fea") || lower.startsWith("feb")) return "always";
  if (blockPrivate) {
    if (lower === "::1" || lower === "::") return "private"; // loopback / unspecified
    const head = parseInt(lower.split(":")[0] || "0", 16);
    if (head >= 0xfc00 && head <= 0xfdff) return "private"; // fc00::/7 ULA
  }
  return "ok";
}

export interface UrlGuardOptions {
  /** Also reject loopback + RFC-1918 + ULA + CGNAT. Default false. */
  blockPrivate?: boolean;
  /** DNS resolver seam for tests. Defaults to node:dns lookup(all). */
  resolve?: (host: string) => Promise<string[]>;
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * Throw {@link SsrfBlockedError} if `rawUrl` is not a safe capture target.
 * Call before navigating a browser to a user-supplied URL.
 */
export async function assertSafeCaptureUrl(
  rawUrl: string,
  opts: UrlGuardOptions = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`not a valid URL: ${rawUrl}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(`scheme "${url.protocol}" not allowed`);
  }

  const blockPrivate = opts.blockPrivate ?? false;
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Determine the addresses to vet: an IP literal is checked directly; a
  // hostname is resolved and every answer is checked.
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    const resolver = opts.resolve ?? defaultResolve;
    try {
      addresses = await resolver(host);
    } catch {
      // Can't resolve → nothing to vet here; the navigation itself will fail.
      return;
    }
  }

  for (const addr of addresses) {
    const verdict = classifyIp(addr, blockPrivate);
    if (verdict === "always") {
      throw new SsrfBlockedError(
        `resolves to link-local/metadata address ${addr}`,
      );
    }
    if (verdict === "private") {
      throw new SsrfBlockedError(
        `resolves to private address ${addr} (CAPTURE_BLOCK_PRIVATE_IPS)`,
      );
    }
  }
}
