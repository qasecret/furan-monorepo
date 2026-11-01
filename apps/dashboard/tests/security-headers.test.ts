import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NextConfig } from "next";
import { describe, expect, it } from "vitest";

// @ts-expect-error -- next.config.mjs is plain JS with no declaration file.
import rawNextConfig from "../next.config.mjs";
import {
  buildDocsCsp,
  DOCS_REWRITES,
  HSTS_HEADER,
  readDocsScriptHashes,
  SECURITY_HEADERS,
} from "../security-headers.mjs";

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

describe("the /docs portal (spec §5)", () => {
  const directive = (csp: string, name: string): string | undefined =>
    csp
      .split("; ")
      .find((d) => d.startsWith(`${name} `))
      ?.slice(name.length + 1);

  it("buildDocsCsp allows exactly the hashed inline scripts", () => {
    const csp = buildDocsCsp(["'sha256-AAA='"]);
    expect(directive(csp, "script-src")).toBe("'self' 'sha256-AAA='");
    expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
    expect(directive(csp, "frame-ancestors")).toBe("'none'");
    expect(directive(csp, "connect-src")).toBe("'self'");
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "worker-src")).toBe("'self' blob:");
  });

  it("readDocsScriptHashes is null when the docs aren't built", () => {
    expect(readDocsScriptHashes("/nonexistent/csp-hashes.json")).toBeNull();
  });

  it("readDocsScriptHashes reads the build's hash list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docs-hashes-"));
    const file = path.join(dir, "csp-hashes.json");
    writeFileSync(file, JSON.stringify({ scriptHashes: ["'sha256-B='"] }));
    try {
      expect(readDocsScriptHashes(file)).toEqual(["'sha256-B='"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("next.config rewrites /docs pages to their .html files, after the filesystem", async () => {
    expect(DOCS_REWRITES).toEqual([
      { source: "/docs", destination: "/docs/index.html" },
      { source: "/docs/:path+", destination: "/docs/:path+.html" },
    ]);
    const rewrites = (await nextConfig.rewrites!()) as {
      fallback: unknown;
    };
    expect(rewrites.fallback).toEqual(DOCS_REWRITES);
  });

  it("next.config sends no /docs policy when the docs aren't built", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.some((r) => r.source === "/docs/:path*")).toBe(false);
  });
});
