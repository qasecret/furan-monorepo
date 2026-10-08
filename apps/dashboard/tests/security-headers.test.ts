import type { NextConfig } from "next";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- next.config.mjs is plain JS with no declaration file.
import rawNextConfig from "../next.config.mjs";
import { HSTS_HEADER, SECURITY_HEADERS } from "../security-headers.mjs";

const nextConfig = rawNextConfig as NextConfig;

function header(key: string): string | undefined {
  return SECURITY_HEADERS.find((h) => h.key === key)?.value;
}

describe("static security headers", () => {
  it("covers framing, sniffing, referrer and powerful features", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("Permissions-Policy")).toContain("camera=()");
  });

  it("HSTS: one year, no includeSubDomains (other hosts on the domain may be http)", () => {
    expect(HSTS_HEADER).toEqual({
      key: "Strict-Transport-Security",
      value: "max-age=31536000",
    });
  });

  it("next.config applies them to every path, HSTS only behind https", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*" && !r.has);
    expect(all?.headers).toEqual(SECURITY_HEADERS);
    const hsts = rules.find((r) => r.headers.includes(HSTS_HEADER));
    expect(hsts?.has).toEqual([
      { type: "header", key: "x-forwarded-proto", value: "https" },
    ]);
  });
});
