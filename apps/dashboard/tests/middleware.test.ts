import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, middleware } from "@/middleware";

function nonceOf(csp: string | null): string | undefined {
  return csp?.match(/'nonce-([^']+)'/)?.[1];
}

describe("middleware (Content-Security-Policy)", () => {
  it("sets a nonce-based CSP on the response", () => {
    const res = middleware(new NextRequest("http://localhost:3001/login"));
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(nonceOf(csp)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("hands the same nonce + policy to the render (request headers)", () => {
    const res = middleware(new NextRequest("http://localhost:3001/home"));
    const csp = res.headers.get("content-security-policy");
    // NextResponse.next({ request: { headers } }) serializes overridden
    // request headers as x-middleware-request-<name>.
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(csp));
    expect(
      res.headers.get("x-middleware-request-content-security-policy"),
    ).toBe(csp);
  });

  it("uses a fresh nonce per request", () => {
    const a = middleware(new NextRequest("http://localhost:3001/"));
    const b = middleware(new NextRequest("http://localhost:3001/"));
    expect(nonceOf(a.headers.get("content-security-policy"))).not.toBe(
      nonceOf(b.headers.get("content-security-policy")),
    );
  });

  it("skips static assets and route handlers", () => {
    const [entry] = config.matcher;
    const re = new RegExp(`^${entry!.source}$`);
    expect(re.test("/login")).toBe(true);
    expect(re.test("/projects/p1/runs/r1/diffs/d1")).toBe(true);
    expect(re.test("/_next/static/chunks/main.js")).toBe(false);
    expect(re.test("/_next/image")).toBe(false);
    expect(re.test("/api/healthz")).toBe(false);
    expect(re.test("/icon.svg")).toBe(false);
  });
});
